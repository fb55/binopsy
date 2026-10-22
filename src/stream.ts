/**
 * Parses input that arrives in chunks (`stream()`). A value that lies within
 * the first buffered chunk is parsed by the compiled parser. Other values,
 * and all values of parsers that read up to the end of the input, are read
 * by generators that yield the number of bytes they need next and receive
 * them once available, so a value spanning chunks is not parsed again from
 * its start (only the compiled attempt is repeated, so formatters should not
 * have side effects).
 */
import { Transform } from "node:stream";
import { parser } from "./compile.ts";
import {
  endOfInput,
  lengthOf,
  noProgress,
  pick,
  readBits,
  resolve,
  tagOf,
  type Field,
  type Obj,
  type Struct,
  type Type,
} from "./fields.ts";
import { PRIMITIVE_TYPES, readPrimitive } from "./primitive-types.ts";

/**
 * Reads a value. Yields byte counts (`Infinity`: the rest of the input) and
 * receives the bytes, or yields `PEEK`.
 */
type Reader<T> = Generator<number, T, Buffer>;

/** Requests the buffered input without consuming it: at least one byte, or none at the end. */
const PEEK = -1;

const EMPTY = Buffer.alloc(0);

function* readType(type: Type): Reader<unknown> {
  const resolved = resolve(type);
  if (typeof resolved === "string") {
    const bytes = yield PRIMITIVE_TYPES[resolved].size;
    return readPrimitive(resolved, bytes, 0);
  }
  return yield* readStruct(resolved);
}

function* readStruct(struct: Struct): Reader<Obj> {
  const obj: Obj = struct.create ? new struct.create() : {};
  for (const field of struct.fields) {
    switch (field.kind) {
      case "bits": {
        const bytes = yield field.bytes;
        for (const bit of field.bits) {
          bit.store(obj, readBits(bytes, 0, bit.pos, bit.width));
        }
        break;
      }
      case "primitive": {
        const bytes = yield PRIMITIVE_TYPES[field.type].size;
        field.store(obj, readPrimitive(field.type, bytes, 0));
        break;
      }
      case "nest": {
        const value = readType(field.type);
        field.store(
          obj,
          yield* field.length === undefined
            ? value
            : region(value, lengthOf(field.length, obj, field.name)),
        );
        break;
      }
      case "string":
        field.store(obj, yield* readString(field, obj));
        break;
      case "buffer":
        field.store(obj, yield lengthOf(field.length, obj, field.name));
        break;
      case "array":
        field.store(obj, yield* readArray(field, obj));
        break;
      case "choice":
        field.store(obj, yield* readType(pick(field, tagOf(field.tag, obj))));
        break;
    }
  }
  return obj;
}

function* readString(
  field: Extract<Field, { kind: "string" }>,
  obj: Obj,
): Reader<string> {
  if (!field.zeroTerminated) {
    return (yield lengthOf(field.length, obj, field.name)).toString(
      field.encoding,
    );
  }
  // Up to `length` bytes; a zero byte ends the string and is consumed.
  const parts: Buffer[] = [];
  for (let left = lengthOf(field.length, obj, field.name); left > 0;) {
    const available = (yield PEEK).subarray(0, left);
    if (available.length === 0) throw endOfInput();
    const zero = available.indexOf(0);
    if (zero >= 0) {
      parts.push(yield zero);
      yield 1;
      break;
    }
    parts.push(yield available.length);
    left -= available.length;
  }
  return Buffer.concat(parts).toString(field.encoding);
}

function* readArray(
  field: Extract<Field, { kind: "array" }>,
  obj: Obj,
): Reader<unknown[]> {
  const { type, until } = field;
  const length = lengthOf(field.length, obj, field.name);
  const items: unknown[] = [];
  // Primitives with a known count: one read.
  if (typeof type === "string" && until === undefined) {
    const { size } = PRIMITIVE_TYPES[type];
    const bytes = yield length * size;
    for (let i = 0; i < length; i++) {
      items.push(readPrimitive(type, bytes, i * size));
    }
    return items;
  }
  while (items.length < length) {
    if (until === "eof" && (yield PEEK).length === 0) break;
    let item: unknown;
    let used = 1;
    if (length === Infinity) [item, used] = yield* measure(readType(type));
    else item = yield* readType(type);
    items.push(item);
    if (typeof until === "function" && until(item as never)) break;
    // An item that reads nothing (and does not end the array) would be read forever.
    if (used === 0) noProgress(field.name);
  }
  return items;
}

/** Runs `reader`, and returns its value with the number of bytes it consumed. */
function* measure<T>(reader: Reader<T>): Reader<[T, number]> {
  let used = 0;
  let step = reader.next();
  while (!step.done) {
    const input = yield step.value;
    if (step.value !== PEEK) used += input.length;
    step = reader.next(input);
  }
  return [step.value, used];
}

/** Limits `reader` to the next `size` bytes, and skips the bytes it leaves. */
function* region<T>(reader: Reader<T>, size: number): Reader<T> {
  let left = size;
  let step = reader.next();
  while (!step.done) {
    let request = step.value;
    let input: Buffer;
    if (request === PEEK) {
      input = left > 0 ? (yield PEEK).subarray(0, left) : EMPTY;
    } else {
      if (request === Infinity) request = left;
      if (request > left) throw endOfInput();
      left -= request;
      input = yield request;
    }
    step = reader.next(input);
  }
  if (left > 0) yield left;
  return step.value;
}

/** Whether values of `type` may extend to the end of the input (so only its end can complete them). */
function openEnded(type: Type, seen = new Set<Type>()): boolean {
  if (typeof type === "string" || seen.has(type)) return false;
  seen.add(type);
  return (resolve(type) as Struct).fields.some((field) => {
    switch (field.kind) {
      case "string":
        return !field.zeroTerminated && field.length === Infinity;
      case "buffer":
        return field.length === Infinity;
      case "array":
        return field.until === "eof" || openEnded(field.type, seen);
      case "nest":
        return field.length === undefined && openEnded(field.type, seen);
      case "choice":
        return [...Object.values(field.choices), field.defaultChoice].some(
          (choice) => choice !== undefined && openEnded(choice, seen),
        );
      default:
        return false;
    }
  });
}

/** A transform stream that parses its input into a sequence of values of `type`. */
export function stream(type: Type): Transform {
  const parse = openEnded(type) ? undefined : parser(type, "all");
  /** Received input not yet consumed; it starts at `offset` in `chunks[0]`. */
  const chunks: Buffer[] = [];
  let offset = 0;
  let available = 0;
  let ended = false;
  /** The value being read, the bytes it consumed, and its pending request. */
  let reader: Reader<unknown> | undefined;
  let used = 0;
  let request = 0;
  /** Continues parsing that stopped because the reader was full. */
  let resume: (() => void) | undefined;

  const transform = new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding, done) {
      if (chunk.length > 0) {
        chunks.push(chunk);
        available += chunk.length;
      }
      run(done);
    },
    flush(done) {
      ended = true;
      run(done);
    },
    read(size) {
      const pending = resume;
      resume = undefined;
      if (pending) pending();
      else Transform.prototype._read.call(this, size);
    },
  });
  return transform;

  /** Parses what it can, then lets the stream continue (once the reader has room). */
  function run(done: (err?: Error) => void): void {
    let full: boolean;
    try {
      full = pump();
    } catch (err) {
      done(err as Error);
      return;
    }
    if (full) resume = () => run(done);
    else done();
  }

  /**
   * Feeds the readers until they wait for more input than there is (returns
   * false), or until the reader is full (returns true).
   */
  function pump(): boolean {
    for (;;) {
      let step: IteratorResult<number, unknown>;
      if (!reader) {
        // A new value starts only if there is input for it.
        if (available === 0) return false;
        used = 0;
        const parsed = parse?.(chunks[0], offset);
        if (parsed) {
          consume(parsed.offset - offset);
          step = { done: true, value: parsed.result };
        } else {
          reader = readType(type);
          step = reader.next();
        }
      } else if (request === PEEK) {
        if (available === 0 && !ended) return false;
        step = reader.next(available ? chunks[0].subarray(offset) : EMPTY);
      } else if (request <= available || (ended && request === Infinity)) {
        step = reader.next(take(Math.min(request, available)));
      } else if (ended) {
        throw endOfInput();
      } else {
        return false;
      }

      if (!step.done) {
        request = step.value;
      } else {
        // Reading nothing, the parser would produce values forever.
        if (used === 0) throw new Error("parsed a value without reading input");
        reader = undefined;
        if (!transform.push(step.value)) return true;
      }
    }
  }

  /** Consumes `n` buffered bytes, joining chunks if they span several. */
  function take(n: number): Buffer {
    if (n === 0) return EMPTY;
    let head = chunks[0];
    if (head.length - offset < n) {
      let size = head.length - offset;
      let count = 1;
      while (size < n) size += chunks[count++].length;
      head = Buffer.concat(
        [head.subarray(offset), ...chunks.slice(1, count)],
        size,
      );
      chunks.splice(0, count, head);
      offset = 0;
    }
    const bytes = head.subarray(offset, offset + n);
    consume(n);
    return bytes;
  }

  function consume(n: number): void {
    offset += n;
    available -= n;
    used += n;
    if (offset === chunks[0].length) {
      chunks.shift();
      offset = 0;
    }
  }
}
