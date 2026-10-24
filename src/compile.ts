/**
 * Compiles codecs to JavaScript: each codec emits code that reads
 * (`Codec#emitRead`) and writes (`Codec#emitWrite`) its values, and each
 * parser becomes one function per mode and selection.
 *
 * Generated functions access `buf` (and `dv`, a `DataView` of it) at `o`.
 * Fixed-size values use constant offsets from `o`, which is only advanced
 * when needed, and consecutive fixed-size fields share one bounds check.
 *
 * - Decoders read a value at `cur.offset`, up to `cur.end`.
 * - Resumable decoders (used by streams) are generators: instead of failing
 *   at the end of the input, they yield the offset they need to reach, and
 *   continue once the cursor holds that many bytes.
 * - Encoders write the value `v` at `w.offset`, growing the writer as needed.
 *
 * Functions of codecs that read fields of the parser they are in (and do
 * not hold them) get those fields as an object, `s`.
 */
import type { AnyCodec, Cursor, Writer } from "./codec.ts";
import {
  DecodeError,
  EncodeError,
  MORE,
  encodingWithin,
  within,
  type Path,
} from "./errors.ts";

/** A callback reads the complete logical prefix, in addition to named dependencies. */
export const ALL_FIELDS = Symbol("all fields");
/** Earlier fields a codec reads (callbacks do not erase the named requirements). */
export type Reads = readonly (string | typeof ALL_FIELDS)[];

/** What a parser decodes: every field, or none (it only steps over the value). */
export type Selection = "all" | "none";

/**
 * Tracing is decoding that records where each field is (in `cur.trace`);
 * sizing is encoding without writing (or checking): only the offset moves.
 */
export type Mode = "decode" | "resume" | "trace" | "encode" | "size";

export type Decoder = (cur: Cursor, scope?: object) => unknown;
export type Encoder = (w: Writer, value: unknown, scope?: object) => void;
type Compiled = (...args: never[]) => unknown;

/** Compiled functions, by mode, whether they get the fields around them, codec and selection. */
const caches = new Map<string, WeakMap<AnyCodec, Map<Selection, Compiled>>>();
/** The cache entries added while compiling, which are removed if compiling fails. */
let added: [Map<Selection, Compiled>, Selection][] | undefined;

/**
 * Whether `codec` reads fields around it (so its function gets them).
 *
 * @param codec The codec to check.
 * @returns `true` if it reads any field, by name or all of them.
 */
export function scoped(codec: AnyCodec): boolean {
  return codec.reads.length > 0;
}

/**
 * The function for `codec` in `mode` (decoding `selection`), compiled on
 * first use; that of a codec `inner` to a parser gets its fields, if it reads them.
 */
export function compile(
  codec: AnyCodec,
  mode: "encode" | "size",
  selection?: "all",
  inner?: boolean,
): Encoder;
export function compile(
  codec: AnyCodec,
  mode: "decode" | "resume" | "trace",
  selection: Selection,
  inner?: boolean,
): Decoder;
export function compile(
  codec: AnyCodec,
  mode: Mode,
  selection: Selection = "all",
  inner = false,
): Compiled {
  // Functions of codecs in a parser get its fields, if they read them.
  const scope = inner && scoped(codec);
  const key = `${mode} ${scope}`;
  let byCodec = caches.get(key);
  if (!byCodec) caches.set(key, (byCodec = new WeakMap()));
  let bySelection = byCodec.get(codec);
  if (!bySelection) {
    bySelection = new Map<Selection, Compiled>();
    byCodec.set(codec, bySelection);
  }
  const cached = bySelection.get(selection);
  if (cached) return cached;

  const outermost = !added;
  added ??= [];
  // A codec that contains itself (through `lazy`) calls this stub until it is built.
  bySelection.set(
    selection,
    mode === "resume"
      ? function* stub(...args: never[]) {
          return yield* fn(...args) as Generator<number, unknown>;
        }
      : (...args) => fn(...args),
  );
  added.push([bySelection, selection]);
  let fn: Compiled;
  try {
    const g = new Gen(mode, scope);
    fn = g.build(codec.emitBody(g, selection));
    if (!inner) {
      const missing = codec.reads.find((name) => name !== ALL_FIELDS);
      if (missing !== undefined) {
        throw new Error(`\`${missing}\` is not a field before it`);
      }
    }
  } catch (e) {
    if (outermost) {
      for (const [map, sel] of added) map.delete(sel);
      added = undefined;
    }
    throw e;
  }
  bySelection.set(selection, fn);
  if (outermost) added = undefined;
  return fn;
}

const NEGATIVE_ZERO = Symbol("-0");

/** Fields read or written together, with the offset each ends at. */
export type Run = readonly (readonly [name: string, end: number])[];

export class Gen {
  readonly mode: Mode;
  /** Locals holding the fields of the parser being compiled (when encoding, the values being encoded). */
  fields = new Map<string, string>();
  /** When the variables of fields of merged matches hold them (those of other cases do not). */
  readonly present = new Map<string, string>();
  /** The object holding the fields around the parser, if it gets them. */
  scope: string | undefined;
  /** The field being emitted (for errors). */
  field: string | undefined;
  /** Variables of the array indexes inside the field. */
  private indexes: string[] = [];
  /** The path of the parser being emitted, in the function's (if it is inlined). */
  private prefix: string[] = [];
  private readonly consts = new Map<unknown, string>();
  private readonly lines: string[] = [];
  /** Variables declared at the start of the function (e.g. set in cases of a `switch`, and read after it). */
  private readonly hoisted: string[] = [];
  private vars = 0;
  /** Bytes read or written since `o` was last advanced. */
  private pos = 0;
  /** Bytes known to be available (or to have room) from `o`. */
  private checked = 0;

  constructor(mode: Mode, scope = false) {
    this.mode = mode;
    this.scope = scope ? "s" : undefined;
  }

  /**
   * Whether the function encodes (or sizes) values.
   *
   * @returns `true` when encoding or sizing.
   */
  get encoding(): boolean {
    return this.mode === "encode" || this.mode === "size";
  }

  /**
   * Emits code recording where the current field is, when tracing.
   *
   * @param start An expression of its offset.
   * @param v The variable holding its value ("" if it is stepped over).
   * @param end An expression of the offset after it.
   */
  trace(start: string, v: string, end = this.at()): void {
    this.line(
      `cur.trace.push({ path: [${["...cur.tracePath", ...this.pathOf()].join(", ")}], start: ${start}, end: ${end}, value: ${v || "undefined"} });`,
    );
  }

  /**
   * When tracing, adds the path of the current field to that of the value,
   * for a function decoding the field (until `traced`).
   *
   * @returns The variable holding the length of the path before, or "".
   */
  mark(): string {
    if (this.mode !== "trace") return "";
    const before = this.let("cur.tracePath.length");
    const path = this.pathOf();
    if (path.length > 0) this.line(`cur.tracePath.push(${path.join(", ")});`);
    return before;
  }

  /**
   * Removes the path `mark` added.
   *
   * @param mark The variable `mark` returned.
   */
  traced(mark: string): void {
    if (mark) this.line(`cur.tracePath.length = ${mark};`);
  }

  /**
   * Emits code that sees no fields around it, as a function of its own that
   * reads none does not.
   *
   * @param emit Emits the code.
   */
  isolated(emit: () => void): void {
    const { fields, scope } = this;
    this.fields = new Map();
    this.scope = undefined;
    try {
      emit();
    } finally {
      Object.assign(this, { fields, scope });
    }
  }

  /**
   * Emits a statement writing bytes (none when sizing).
   *
   * @param statement The code of the statement.
   */
  write(statement: string): void {
    if (this.mode !== "size") this.line(statement);
  }

  /**
   * The name of a constant holding `value`.
   *
   * @param value The value, of any type.
   * @returns The name, the same for equal values (as by `Object.is`).
   */
  k(value: unknown): string {
    // (Keys of maps are equal as with `===`, which -0 is to 0.)
    const key = Object.is(value, -0) ? NEGATIVE_ZERO : value;
    let name = this.consts.get(key);
    if (name === undefined) {
      name = `k${this.consts.size}`;
      this.consts.set(key, name);
    }
    return name;
  }

  /**
   * A new variable holding `expr`.
   *
   * @param expr An expression of the value.
   * @param keyword How the variable is declared (`let` if it is set later).
   * @returns The name of the variable.
   */
  let(expr: string, keyword: "const" | "let" = "const"): string {
    const v = `v${this.vars++}`;
    this.line(`${keyword} ${v} = ${expr};`);
    return v;
  }

  /**
   * A new variable, declared at the start of the function.
   *
   * @returns The name of the variable.
   */
  hoist(): string {
    const v = `h${this.hoisted.length}`;
    this.hoisted.push(v);
    return v;
  }

  line(code: string): void {
    this.lines.push(code);
  }

  /**
   * The offset `k` bytes after the current position.
   *
   * @param k The number of bytes, or an expression of it.
   * @returns An expression of the offset.
   */
  at(k: number | string = 0): string {
    if (typeof k === "string") {
      return this.pos ? `o + ${this.pos} + ${k}` : `o + ${k}`;
    }
    return this.pos + k ? `o + ${this.pos + k}` : "o";
  }

  /**
   * Whether a previous bounds check already covers `n` bytes at this position.
   *
   * @param n The number of bytes.
   * @returns `true` if the bytes need no check of their own.
   */
  available(n: number): boolean {
    return this.pos + n <= this.checked;
  }

  /**
   * Ensures that `n` more bytes can be read (or written); `run` names the
   * fields they belong to, for errors.
   *
   * @param n The number of bytes, or an expression of it.
   * @param run The fields of the bytes, with the offsets they end at.
   */
  need(n: number | string, run?: Run): void {
    if (this.mode === "size") return;
    if (typeof n === "number") {
      if (this.available(n)) return;
      this.checked = this.pos + n;
    }
    const reach = this.at(n);
    if (this.mode === "encode") {
      // The writer keeps the bytes up to the current position, which may be past `o`.
      const back = this.pos ? ` - ${this.pos}` : "";
      this.line(
        `if (${reach} > buf.length) { w.offset = ${this.at()}; w.room(${n}); o = w.offset${back}; buf = w.bytes; dv = w.view; }`,
      );
    } else if (this.mode === "resume") {
      this.line(`while (${reach} > end) {`);
      this.check(
        `!Number.isSafeInteger(${reach})`,
        "invalid",
        '"length exceeds the safe offset range"',
      );
      this.line(`yield ${reach}; ${this.reload()} }`);
    } else {
      const error = run
        ? `${this.k(runEnded)}(${this.at()}, end, ${this.k(run)}, ${this.path()})`
        : `${this.k(ended)}(${this.at()}, ${reach}, end, ${this.path()})`;
      this.line(`if (${reach} > end) throw ${this.ending(error)};`);
    }
  }

  /**
   * Moves past `n` bytes.
   *
   * @param n The number of bytes, or an expression of it.
   */
  skip(n: number | string): void {
    if (typeof n === "number") {
      this.pos += n;
    } else {
      this.flush();
      this.line(`o += ${n};`);
      this.checked = 0;
    }
  }

  /**
   * Moves to `offset`.
   *
   * @param offset An expression of the offset.
   */
  seek(offset: string): void {
    this.flush();
    this.line(`o = ${offset};`);
    this.checked = 0;
  }

  /** Advances `o` to the current position. */
  flush(): void {
    if (!this.pos) return;
    this.line(`o += ${this.pos};`);
    this.checked -= this.pos;
    this.pos = 0;
  }

  /**
   * Emits `head { body tail`; positions inside and after it are only known at
   * run time.
   *
   * @param head The code before the brace, e.g. `if (…)`.
   * @param body Emits the code inside the block.
   * @param tail The code ending the block, e.g. `break; }`.
   */
  block(head: string, body: () => void, tail = "}"): void {
    this.flush();
    this.checked = 0;
    this.line(`${head} {`);
    body();
    this.flush();
    this.line(tail);
    this.checked = 0;
  }

  /**
   * Emits a loop over an index from 0 to `count` (without one, until the
   * body breaks); `each` bytes are available in each iteration.
   *
   * @param count An expression of the number of iterations, or `undefined`.
   * @param body Emits the code of an iteration, given the index's variable.
   * @param each The number of bytes known to be available in an iteration.
   */
  loop(count: string | undefined, body: (i: string) => void, each = 0): void {
    const i = `i${this.vars++}`;
    const test = count === undefined ? "" : ` ${i} < ${count}`;
    this.block(`for (let ${i} = 0;${test}; ${i}++)`, () => {
      this.checked = each;
      this.indexes.push(i);
      body(i);
      this.indexes.pop();
    });
  }

  /**
   * Emits the code of a parser inlined at the current position: its fields
   * are its own (and it sees those around it).
   *
   * @param emit Emits the parser's code.
   * @returns What `emit` returns.
   */
  inline<T>(emit: () => T): T {
    const { fields, field, indexes, prefix } = this;
    this.prefix = this.pathOf();
    this.indexes = [];
    this.fields = new Map(fields);
    this.field = undefined;
    try {
      return emit();
    } finally {
      Object.assign(this, { fields, field, indexes, prefix });
    }
  }

  /**
   * Emits a call of the function of `codec` at the current position:
   * decoding (`wanted` or not) or encoding `value`; returns the value.
   *
   * @param codec The codec whose function is called.
   * @param arg Whether the value is wanted, or (encoding) an expression of it.
   * @returns The variable holding the decoded value, or "" if there is none.
   */
  call(codec: AnyCodec, arg: boolean | string): string {
    const scope = scoped(codec) ? `, ${this.context(codec.reads)}` : "";
    this.flush();
    let v = "";
    const { mode } = this;
    if (mode === "encode" || mode === "size") {
      const fn = this.k(compile(codec, mode, "all", true));
      this.line("w.offset = o;");
      this.guard(`${fn}(w, ${arg as string}${scope});`);
      this.line(this.reload());
    } else {
      const fn = this.k(
        compile(codec, mode, arg === true ? "all" : "none", true),
      );
      v = this.let("undefined", "let");
      const mark = this.mark();
      this.line("cur.offset = o;");
      this.guard(
        `${v} = ${this.mode === "resume" ? "yield* " : ""}${fn}(cur${scope});`,
      );
      this.line(
        `o = cur.offset;${this.mode === "resume" ? ` ${this.reload()}` : ""}`,
      );
      this.traced(mark);
    }
    this.checked = 0;
    return arg === true ? v : "";
  }

  /**
   * Emits code waiting for the end of the input; returns the number of bytes
   * left.
   *
   * @returns The variable holding the number of bytes after the position.
   */
  rest(): string {
    this.line(
      this.mode === "resume"
        ? `while (!cur.final) { yield Infinity; ${this.reload()} }`
        : `if (!cur.final) throw ${this.k(MORE)};`,
    );
    return this.let(`end - (${this.at()})`);
  }

  /**
   * Emits a call of a function (of the user's, or one that may throw);
   * returns its value.
   *
   * @param fn The function to call.
   * @param args Expressions of its arguments.
   * @returns The variable holding its result.
   */
  callback(fn: (...args: never[]) => unknown, ...args: string[]): string {
    return this.callbackAt(this.at(), fn, ...args);
  }

  /**
   * Calls a function whose failure belongs to the value beginning at `at`.
   *
   * @param at An expression of the offset of the value.
   * @param fn The function to call.
   * @param args Expressions of its arguments.
   * @returns The variable holding its result.
   */
  callbackAt(
    at: string,
    fn: (...args: never[]) => unknown,
    ...args: string[]
  ): string {
    const v = this.let("undefined", "let");
    this.guard(`${v} = ${this.k(fn)}(${args.join(", ")});`, undefined, at);
    return v;
  }

  /**
   * Emits a check that fails if `failed` holds (decoding: at offset `at`).
   *
   * @param failed An expression that is true if the value is wrong.
   * @param code The code of the `DecodeError` (when decoding).
   * @param detail An expression of the error's detail.
   * @param at An expression of the offset of the error.
   */
  check(
    failed: string,
    code: DecodeError["code"],
    detail: string,
    at = this.at(),
  ): void {
    if (this.mode === "size") return;
    const error = this.error(code, detail, at);
    this.line(
      `if (${failed}) throw ${code === "end-of-input" ? this.ending(error) : error};`,
    );
  }

  /**
   * Emits a statement that fails.
   *
   * @param code The code of the `DecodeError` (when decoding).
   * @param detail An expression of the error's detail.
   */
  fail(code: DecodeError["code"], detail: string): void {
    this.line(`throw ${this.error(code, detail)};`);
  }

  /**
   * An expression of the error of a failure at the current field.
   *
   * @param code The code of the `DecodeError` (when decoding).
   * @param detail An expression of the error's detail.
   * @param at An expression of the offset of the error.
   * @returns A `DecodeError`, or (encoding) an `EncodeError`.
   */
  private error(
    code: DecodeError["code"],
    detail: string,
    at = this.at(),
  ): string {
    return this.encoding
      ? `${this.k(encodeFailed)}(${detail}, ${this.path()})`
      : `new ${this.k(DecodeError)}(${JSON.stringify(code)}, ${detail}, ${at}, ${this.path()})`;
  }

  /**
   * What decoding throws at the end of the input: `error`, or `MORE` if more
   * input may follow.
   *
   * @param error An expression of the error.
   * @returns An expression of the value to throw.
   */
  private ending(error: string): string {
    return `cur.final ? ${error} : ${this.k(MORE)}`;
  }

  /**
   * An object of the fields before the current one (and around the parser),
   * for callbacks.
   *
   * @param reads The fields the object holds (by default, all of them).
   * @returns The variable holding the object.
   */
  context(reads: Reads = [ALL_FIELDS]): string {
    const named = new Map<string, string>();
    for (const name of reads) {
      if (name !== ALL_FIELDS) named.set(name, this.ref(name));
    }
    const all = reads.includes(ALL_FIELDS);
    const fields = [...(all ? this.fields : named)];
    // Fields from the first one of a merged match on are added if present.
    const i = fields.findIndex(([, v]) => this.present.has(v));
    const entries = fields
      .slice(0, i === -1 ? undefined : i)
      .map(([name, v]) => `${JSON.stringify(name)}: ${v}`);
    if (all && this.scope !== undefined) entries.unshift(`...${this.scope}`);
    const object = this.let(`{ ${entries.join(", ")} }`);
    for (const [name, v] of i === -1 ? [] : fields.slice(i)) {
      const when = this.present.get(v);
      const set = `${object}[${JSON.stringify(name)}] = ${v};`;
      this.line(when === undefined ? set : `if (${when}) ${set}`);
    }
    return object;
  }

  /**
   * The expression of field `name` (of the parser, or around it).
   *
   * @param name The name of the field.
   * @returns Its variable, or a property of the object of outer fields.
   */
  ref(name: string): string {
    const v = this.fields.get(name);
    if (v !== undefined) {
      // A field of only some cases may be one around the parser.
      const when = this.present.get(v);
      return this.scope !== undefined && when !== undefined
        ? `(${when} ? ${v} : ${this.scope}[${JSON.stringify(name)}])`
        : v;
    }
    if (this.scope !== undefined) {
      return `${this.scope}[${JSON.stringify(name)}]`;
    }
    throw new Error(
      `\`${name}\` is not a field before ${this.field === undefined ? "it" : `\`${this.field}\``}`,
    );
  }

  /**
   * Builds the function; decoders return `result`.
   *
   * @param result An expression of the decoded value, or "" for `undefined`.
   * @returns The compiled function.
   */
  build(result: string): Compiled {
    this.flush();
    const s = this.scope === undefined ? "" : `, ${this.scope}`;
    const [head, setup, done] = this.encoding
      ? [
          `function encode(w, v${s})`,
          "let buf = w.bytes, dv = w.view, o = w.offset;",
          "w.offset = o;",
        ]
      : [
          `function${this.mode === "resume" ? "*" : ""} decode(cur${s})`,
          `${this.mode === "resume" ? "let" : "const"} buf = cur.bytes, dv = cur.view, end = cur.end;\nlet o = cur.offset;`,
          `cur.offset = o;\nreturn ${result || "undefined"};`,
        ];
    const source = [
      '"use strict";',
      ...[...this.consts.values()].map((name, i) => `const ${name} = K[${i}];`),
      `return ${head} {`,
      setup,
      ...(this.hoisted.length > 0 ? [`let ${this.hoisted.join(", ")};`] : []),
      ...this.lines,
      done,
      "};",
    ].join("\n");
    const values = [...this.consts.keys()].map((key) =>
      key === NEGATIVE_ZERO ? -0 : key,
    );
    // oxlint-disable-next-line no-new-func, typescript/no-implied-eval -- Codecs compile to functions.
    const make = new Function("K", source) as (
      constants: unknown[],
    ) => Compiled;
    return make(values);
  }

  /**
   * Statements reloading the buffer, which the stream or a growing writer
   * (moving the offset) may have replaced.
   *
   * @returns The code of the statements, for the mode.
   */
  reload(): string {
    return this.encoding
      ? "o = w.offset; buf = w.bytes; dv = w.view;"
      : "buf = cur.bytes; dv = cur.view; end = cur.end;";
  }

  /**
   * Emits a statement whose errors are located at the current field (and then
   * runs `always`).
   *
   * @param statement The code of the statement.
   * @param always Code run after the statement, even if it throws.
   * @param at An expression of the offset where decoding errors are located.
   */
  guard(statement: string, always?: string, at = this.at()): void {
    const located = this.encoding
      ? `${this.k(encodingWithin)}(e, ${this.path()})`
      : `${this.k(within)}(e, ${at}, ${this.path()})`;
    const end = always === undefined ? "" : ` finally { ${always} }`;
    this.line(`try { ${statement} } catch (e) { throw ${located}; }${end}`);
  }

  /**
   * The location of the current field, as an array expression.
   *
   * @returns An array of the field names and index variables, as code.
   */
  path(): string {
    return `[${this.pathOf().join(", ")}]`;
  }

  private pathOf(): string[] {
    const field = this.field === undefined ? [] : [JSON.stringify(this.field)];
    return [...this.prefix, ...field, ...this.indexes];
  }
}

function ended(
  from: number,
  reach: number,
  end: number,
  path: Path,
): DecodeError {
  const safe = Number.isSafeInteger(reach);
  return new DecodeError(
    safe ? "end-of-input" : "invalid",
    safe
      ? `unexpected end of input (${reach - from} bytes needed, ${end - from} left)`
      : "length exceeds the safe offset range",
    from,
    path,
  );
}

/**
 * The end of input within a run of fields starting at `start`: in the first
 * field it cuts.
 *
 * @param start The offset where the run starts.
 * @param end The offset where the input ends.
 * @param run The fields, with the offsets (from `start`) they end at.
 * @param path The location of the run.
 * @returns The error, in the first field that does not fit.
 */
function runEnded(
  start: number,
  end: number,
  run: Run,
  path: Path,
): DecodeError {
  let from = start;
  for (const [name, until] of run) {
    if (start + until > end) {
      return ended(from, start + until, end, [...path, name]);
    }
    from = start + until;
  }
  return ended(start, start + run.at(-1)![1], end, path);
}

function encodeFailed(detail: string, path: Path): EncodeError {
  return encodingWithin(new EncodeError(detail), path);
}
