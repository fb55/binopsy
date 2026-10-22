/**
 * Parses complete input (`parse`, `parseFrom`) by compiling a parser's
 * fields into a specialised function: primitives are read with inlined byte
 * arithmetic, nested parsers are called directly, and plain fields are
 * assigned without going through `store`.
 *
 * A parser can also be compiled for *partial* parsing: only some top-level
 * fields are decoded, or none, to skip a value. Other fields are stepped
 * over without decoding strings, slicing buffers, running formatters or
 * building nested objects; asserts still run. Fields that later lengths or
 * choice tags refer to by name are always decoded. A parser level that uses
 * functions for lengths, tags, `readUntil` or asserts may depend on any of
 * its fields, so such levels are always decoded completely.
 *
 * Compiled functions read from `buf` at `cur.o` (advancing it) and never
 * past `cur.end`; when the input ends early they throw `END_OF_INPUT`.
 */
import {
  invalidLength,
  lengthOf,
  noProgress,
  pick,
  readBits,
  tagOf,
  type Choice,
  type Field,
  type Length,
  type Named,
  type Struct,
  type Type,
  type ValueOptions,
} from "./fields.ts";
import { PRIMITIVE_TYPES, type PrimitiveName } from "./primitive-types.ts";

/** Read position and limit shared by a compiled function and the functions it calls. */
interface Cursor {
  o: number;
  end: number;
}

/** A compiled parser: reads one value at `cur.o` and returns it. */
type Compiled = (buf: Buffer, cur: Cursor) => unknown;

/** Thrown by compiled functions when the input ends before the value does. */
const END_OF_INPUT = Symbol("end of input");

/**
 * What to decode: every field, or only the named fields of the top level
 * (an empty set skips the value).
 */
export type Selection = "all" | ReadonlySet<string>;

/** Decodes nothing (used to step over values). */
const NOTHING: Selection = new Set();

/**
 * Returns a function parsing a value of `type` (or the selected fields of
 * it) at an offset. It returns the value and the offset after it, or
 * `undefined` if the buffer ends before the value does.
 */
export function parser(
  type: Type,
  selection: Selection,
): (
  buffer: Buffer,
  offset: number,
) => { result: unknown; offset: number } | undefined {
  const fn = compiled(type, selection);
  return (buffer, offset) => {
    const cur = { o: offset, end: buffer.length };
    try {
      const result = fn(buffer, cur);
      return { result, offset: cur.o };
    } catch (err) {
      if (err === END_OF_INPUT) return undefined;
      throw err;
    }
  };
}

const cache = new WeakMap<object, Map<Selection, Compiled>>();
const primitives = new Map<PrimitiveName, Compiled>();

/** The compiled function for `type`, cached per type and selection. */
function compiled(type: Type, selection: Selection): Compiled {
  if (typeof type === "string") {
    let fn = primitives.get(type);
    if (!fn) {
      const g = new Generator("all");
      g.emit(`const obj = ${g.primitive(type)};`);
      primitives.set(type, (fn = g.build()));
    }
    return fn;
  }
  let bySelection = cache.get(type);
  if (!bySelection) cache.set(type, (bySelection = new Map()));
  let fn = bySelection.get(selection);
  if (!fn) {
    if (typeof type === "function") {
      // Compiled on first call: a lazy type may contain itself.
      let target: Compiled | undefined;
      fn = (buf, cur) => (target ??= compiled(type(), selection))(buf, cur);
    } else {
      fn = compileStruct(type, selection);
    }
    bySelection.set(selection, fn);
  }
  return fn;
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

/** Whether a level's layout may depend on any of its fields (so it is always decoded completely). */
function isOpaque(fields: readonly Field[]): boolean {
  // An assert may depend on other fields if it is a function or checks a formatted value.
  const asserts = ({ assert, formatter }: ValueOptions) =>
    isFunction(assert) || (assert !== undefined && formatter !== undefined);
  return fields.some((field) => {
    if (field.kind === "bits") {
      return field.bits.some((bit) => asserts(bit.options));
    }
    if (asserts(field.options)) return true;
    switch (field.kind) {
      case "primitive":
        return false;
      case "choice":
        return isFunction(field.tag);
      case "array":
        return isFunction(field.length) || isFunction(field.until);
      default:
        return isFunction(field.length);
    }
  });
}

function compileStruct(struct: Struct, selection: Selection): Compiled {
  let sel = selection;
  if (sel !== "all") {
    if (isOpaque(struct.fields)) {
      sel = "all";
    } else {
      // The fields that lengths and tags refer to are needed to step over the others.
      const names = new Set(sel);
      for (const field of struct.fields) {
        const ref =
          field.kind === "choice"
            ? field.tag
            : "length" in field
              ? field.length
              : undefined;
        if (typeof ref === "string") names.add(ref);
      }
      sel = names;
    }
  }
  const g = new Generator(sel);
  g.emit(
    struct.create
      ? `const obj = new ${g.k(struct.create)}();`
      : "const obj = {};",
  );
  for (const field of struct.fields) g.field(field);
  return g.build();
}

/** Emits the code of one compiled function. */
class Generator {
  private readonly consts: unknown[] = [];
  private readonly lines: string[] = [];
  private tmp = 0;
  private readonly selection: Selection;

  constructor(selection: Selection) {
    this.selection = selection;
  }

  /** Binds `value` to a name in the generated code. */
  k(value: unknown): string {
    return `k${this.consts.push(value) - 1}`;
  }

  /** A fresh variable name. */
  private v(): string {
    return `v${this.tmp++}`;
  }

  emit(line: string): void {
    this.lines.push(line);
  }

  build(): Compiled {
    const body = [
      '"use strict";',
      ...this.consts.map((_, i) => `const k${i} = K[${i}];`),
      "return function compiled(buf, cur) {",
      "let o = cur.o;",
      "const end = cur.end;",
      ...this.lines,
      "cur.o = o;",
      "return obj;",
      "};",
    ].join("\n");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function("K", "EOI", body)(
      this.consts,
      END_OF_INPUT,
    ) as Compiled;
  }

  /** Whether a field's value is needed: it is selected, flattened or asserted. */
  private wanted(field: Named): boolean {
    const { assert, flatten, formatter } = field.options;
    return (
      this.selection === "all" ||
      this.selection.has(field.name) ||
      assert !== undefined ||
      (flatten === true && formatter !== undefined)
    );
  }

  /**
   * The selection for a nested value: all if it is wanted, else nothing,
   * except that the fields of a flattened value are fields of this level.
   */
  private inner(field: Named, wanted: boolean): Selection {
    if (wanted) return "all";
    return field.options.flatten ? this.selection : NOTHING;
  }

  private store(field: Named, value: string): void {
    if (field.options.flatten) {
      this.emit(`${this.k(field.store)}(obj, ${value});`);
      return;
    }
    const prepared = field.prepare
      ? `${this.k(field.prepare)}(obj, ${value})`
      : value;
    this.emit(`obj[${JSON.stringify(field.name)}] = ${prepared};`);
  }

  /**
   * Emits the length of a field into a variable and returns it; computed
   * lengths are checked like `lengthOf` does. `Infinity` becomes `infinity`.
   */
  private length(
    field: { name: string; length: Length },
    infinity = "end - o",
  ): string {
    const { length } = field;
    const v = this.v();
    if (typeof length === "number") {
      this.emit(`const ${v} = ${length === Infinity ? infinity : length};`);
      return v;
    }
    const name = JSON.stringify(field.name);
    if (typeof length === "string") {
      const key = JSON.stringify(length);
      this.emit(
        `const ${v} = ${key} in obj ? obj[${key}] : ${this.k(lengthOf)}(${key}, obj, ${name});`,
      );
    } else {
      this.emit(`const ${v} = ${this.k(length)}.call(obj, obj);`);
    }
    this.emit(
      `if (!Number.isInteger(${v}) || ${v} < 0) ${this.k(invalidLength)}(${v}, ${name});`,
    );
    return v;
  }

  /** Emits a bounds check and, if `wanted`, a read of primitive `name`; returns its variable. */
  primitive(name: PrimitiveName, wanted = true): string {
    const { size } = PRIMITIVE_TYPES[name];
    const v = this.v();
    this.emit(`if (o + ${size} > end) throw EOI;`);
    if (wanted) this.emit(`const ${v} = ${readExpr(name, "o")};`);
    this.emit(`o += ${size};`);
    return v;
  }

  /** Emits a call of the compiled function `fn` at `o`; returns the variable holding the value. */
  private call(fn: string): string {
    const v = this.v();
    this.emit("cur.o = o;");
    this.emit(`const ${v} = ${fn}(buf, cur);`);
    this.emit("o = cur.o;");
    return v;
  }

  /** Emits code reading a value of `type`, decoded only if `wanted`; returns its variable. */
  private nested(type: Type, wanted: boolean): string {
    if (typeof type === "string") return this.primitive(type, wanted);
    return this.call(this.k(compiled(type, wanted ? "all" : NOTHING)));
  }

  field(field: Field): void {
    if (field.kind === "bits") {
      this.emit(`if (o + ${field.bytes} > end) throw EOI;`);
      for (const bit of field.bits) {
        if (!this.wanted(bit)) continue;
        this.store(
          bit,
          `${this.k(readBits)}(buf, o, ${bit.pos}, ${bit.width})`,
        );
      }
      this.emit(`o += ${field.bytes};`);
      return;
    }
    const wanted = this.wanted(field);
    switch (field.kind) {
      case "primitive": {
        const v = this.primitive(field.type, wanted);
        if (wanted) this.store(field, v);
        return;
      }
      case "string":
        return this.string(field, wanted);
      case "buffer": {
        const len = this.length(field);
        this.emit(`if (o + ${len} > end) throw EOI;`);
        if (wanted) this.store(field, `buf.subarray(o, o + ${len})`);
        this.emit(`o += ${len};`);
        return;
      }
      case "array":
        return this.array(field, wanted);
      case "nest": {
        const selection = this.inner(field, wanted);
        const keep = wanted || field.options.flatten === true;
        if (field.length === undefined) {
          const v =
            typeof field.type === "string"
              ? this.primitive(field.type, keep)
              : this.call(this.k(compiled(field.type, selection)));
          if (keep) this.store(field, v);
          return;
        }
        // A fixed-size region: the value may not read past it, and is followed by padding.
        const len = this.length({ name: field.name, length: field.length });
        const [start, saved] = [this.v(), this.v()];
        this.emit(`const ${start} = o;`);
        this.emit(`if (o + ${len} > end) throw EOI;`);
        this.emit(`const ${saved} = cur.end;`);
        this.emit(`cur.end = o + ${len};`);
        const v = this.call(this.k(compiled(field.type, selection)));
        this.emit(`cur.end = ${saved};`);
        this.emit(`o = ${start} + ${len};`);
        if (keep) this.store(field, v);
        return;
      }
      case "choice":
        return this.choice(field, wanted);
    }
  }

  private choice(field: Choice, wanted: boolean): void {
    const selection = this.inner(field, wanted);
    const fns = Object.create(null) as Record<string, Compiled>;
    for (const key of Object.keys(field.choices)) {
      fns[key] = compiled(field.choices[key], selection);
    }
    // Other tag values go through `pick`, for the default choice or the error.
    const other = (key: string | number) =>
      compiled(pick(field, key), selection);
    const { tag } = field;
    const key = this.v();
    if (typeof tag === "string") {
      const name = JSON.stringify(tag);
      this.emit(
        `const ${key} = ${name} in obj ? obj[${name}] : ${this.k(tagOf)}(${name}, obj);`,
      );
    } else {
      this.emit(`const ${key} = ${this.k(tagOf)}(${this.k(tag)}, obj);`);
    }
    const v = this.call(`(${this.k(fns)}[${key}] ?? ${this.k(other)}(${key}))`);
    if (wanted || field.options.flatten) this.store(field, v);
  }

  private string(field: Extract<Field, { kind: "string" }>, wanted: boolean) {
    const enc = JSON.stringify(field.encoding);
    if (field.zeroTerminated) {
      // Up to `length` bytes; a zero byte ends the string and is consumed.
      const max = this.length(field, "Infinity");
      const [lim, e] = [this.v(), this.v()];
      this.emit(`const ${lim} = Math.min(end, o + ${max});`);
      this.emit(`let ${e} = o;`);
      this.emit(`while (${e} < ${lim} && buf[${e}] !== 0) ${e}++;`);
      this.emit(`if (${e} === ${lim} && ${lim} < o + ${max}) throw EOI;`);
      if (wanted) this.store(field, `buf.toString(${enc}, o, ${e})`);
      this.emit(`o = ${e} < ${lim} ? ${e} + 1 : ${e};`);
      return;
    }
    const len = this.length(field);
    this.emit(`if (o + ${len} > end) throw EOI;`);
    if (wanted) this.store(field, `buf.toString(${enc}, o, o + ${len})`);
    this.emit(`o += ${len};`);
  }

  private array(field: Extract<Field, { kind: "array" }>, wanted: boolean) {
    const { type, until } = field;
    // Without a count, items are read up to the end or until `readUntil` returns true.
    const unbounded = field.length === Infinity;
    const n = unbounded ? "" : this.length(field);
    const [arr, i] = [this.v(), this.v()];

    // Primitives with a known count: one bounds check.
    if (typeof type === "string" && until === undefined) {
      const { size } = PRIMITIVE_TYPES[type];
      this.emit(`if (o + ${n} * ${size} > end) throw EOI;`);
      if (wanted) {
        this.emit(`const ${arr} = new Array(${n});`);
        this.emit(
          `for (let ${i} = 0; ${i} < ${n}; ${i}++) ${arr}[${i}] = ${readExpr(type, `o + ${i} * ${size}`)};`,
        );
        this.store(field, arr);
      }
      this.emit(`o += ${n} * ${size};`);
      return;
    }

    if (wanted) this.emit(`const ${arr} = [];`);
    this.emit(
      unbounded
        ? `for (let ${i} = o; ${until === "eof" ? "o < end" : ""}; ${i} = o) {`
        : `for (let ${i} = 0; ${i} < ${n}; ${i}++) {`,
    );
    const v = this.nested(type, wanted);
    if (wanted) this.emit(`${arr}.push(${v});`);
    if (typeof until === "function") {
      this.emit(`if (${this.k(until)}(${v})) break;`);
    }
    // An item that reads nothing (and does not end the array) would be read forever.
    if (unbounded) {
      this.emit(
        `if (o === ${i}) ${this.k(noProgress)}(${JSON.stringify(field.name)});`,
      );
    }
    this.emit("}");
    if (wanted) this.store(field, arr);
  }
}

/** Expression reading primitive `name` at `buf[at]` (bounds already checked). */
function readExpr(name: PrimitiveName, at: string): string {
  const b = (i: number) => (i === 0 ? `buf[${at}]` : `buf[${at} + ${i}]`);
  switch (name) {
    case "uint8":
      return b(0);
    case "int8":
      return `(${b(0)} << 24 >> 24)`;
    case "uint16le":
      return `(${b(0)} | ${b(1)} << 8)`;
    case "uint16be":
      return `(${b(0)} << 8 | ${b(1)})`;
    case "int16le":
      return `((${b(0)} | ${b(1)} << 8) << 16 >> 16)`;
    case "int16be":
      return `((${b(0)} << 8 | ${b(1)}) << 16 >> 16)`;
    case "uint32le":
      return `((${b(0)} | ${b(1)} << 8 | ${b(2)} << 16) + ${b(3)} * 16777216)`;
    case "uint32be":
      return `(${b(0)} * 16777216 + (${b(1)} << 16 | ${b(2)} << 8 | ${b(3)}))`;
    case "int32le":
      return `(${b(0)} | ${b(1)} << 8 | ${b(2)} << 16 | ${b(3)} << 24)`;
    case "int32be":
      return `(${b(0)} << 24 | ${b(1)} << 16 | ${b(2)} << 8 | ${b(3)})`;
    default:
      return `buf.${PRIMITIVE_TYPES[name].read}(${at})`;
  }
}
