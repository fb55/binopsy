/**
 * Generated functions access `buf` (and `dv`, a `DataView` of it) at `o`,
 * which only advances when needed: fixed-size values use constant offsets
 * from it, and share one bounds check. Decoders read from the cursor `cur`
 * up to `end`; resumable ones (for streams) are generators that yield the
 * offset they need instead of failing. Encoders write `v` with the writer
 * `w`. Functions of codecs that read fields around them get those as `s`.
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

/** In `Reads`: a function of the earlier fields, which may read any of them. */
export const ALL_FIELDS = Symbol("all fields");
/** Earlier fields a codec reads (callbacks do not erase the named requirements). */
export type Reads = readonly (string | typeof ALL_FIELDS)[];

/** `"none"` steps over the value (still running its checks). */
export type Selection = "all" | "none";

/**
 * `buffer` decodes through a view of the input's whole buffer; `trace`
 * records spans in `cur.trace`; `size` only moves the offset (without
 * writing, or checking other than sizes).
 */
export type Mode = "decode" | "buffer" | "resume" | "trace" | "encode" | "size";

export type Decoder = (cur: Cursor, scope?: object) => unknown;
export type Encoder = (w: Writer, value: unknown, scope?: object) => void;
type Compiled = (...args: never[]) => unknown;

/** By `${mode} ${scope}` (whether the function gets the fields around it), codec and selection. */
const caches = new Map<string, WeakMap<AnyCodec, Map<Selection, Compiled>>>();
/** Entries added by the outermost compilation in progress (stubs, too), removed if it fails. */
let added: [Map<Selection, Compiled>, Selection][] | undefined;

export function scoped(codec: AnyCodec): boolean {
  return codec.reads.length > 0;
}

/**
 * Compiled on first use. The function of an `inner` codec (called by a
 * parser's) gets the fields it reads around it; others may read none.
 */
export function compile(
  codec: AnyCodec,
  mode: "encode" | "size",
  selection?: "all",
  inner?: boolean,
): Encoder;
export function compile(
  codec: AnyCodec,
  mode: "decode" | "buffer" | "resume" | "trace",
  selection: Selection,
  inner?: boolean,
): Decoder;
export function compile(
  codec: AnyCodec,
  mode: Mode,
  selection: Selection = "all",
  inner = false,
): Compiled {
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

/** Fields checked together, to locate an end of input in the first one it cuts (bit fields may share bytes). */
export type Run = readonly (readonly [
  name: string,
  start: number,
  end: number,
])[];

/**
 * Generates one function. Its methods take and return JavaScript source:
 * expressions, and names of variables ("" for no value).
 */
export class Gen {
  readonly mode: Mode;
  /** Whether reads use `dv` (in `buffer` mode, at offsets plus `base`). */
  usesView = false;
  /** The variables of fields by name (when encoding, of the values being encoded). */
  fields = new Map<string, string>();
  /** For variables of fields of merged matches: when they hold them (other cases leave them unset). */
  readonly present = new Map<string, string>();
  /** The variable of the fields around the parser, if the function gets them. */
  scope: string | undefined;
  /** The field being emitted, for the paths of errors and traces. */
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

  get encoding(): boolean {
    return this.mode === "encode" || this.mode === "size";
  }

  trace(start: string, v: string, end = this.at()): void {
    this.line(
      `cur.trace.push({ path: [${["...cur.tracePath", ...this.pathOf()].join(", ")}], start: ${start}, end: ${end}, value: ${v || "undefined"} });`,
    );
  }

  /**
   * When tracing, before calling a function decoding the current field:
   * prefixes the paths it records with the field's (until `traced`).
   *
   * @returns The variable of the length of the path before, or "".
   */
  mark(): string {
    if (this.mode !== "trace") return "";
    const before = this.let("cur.tracePath.length");
    const path = this.pathOf();
    if (path.length > 0) this.line(`cur.tracePath.push(${path.join(", ")});`);
    return before;
  }

  traced(mark: string): void {
    if (mark) this.line(`cur.tracePath.length = ${mark};`);
  }

  isolated<T>(emit: () => T): T {
    const { fields, scope } = this;
    this.fields = new Map();
    this.scope = undefined;
    try {
      return emit();
    } finally {
      Object.assign(this, { fields, scope });
    }
  }

  write(statement: string): void {
    if (this.mode !== "size") this.line(statement);
  }

  /**
   * @param value Any value.
   * @returns The name of a constant holding it, the same for equal values
   *   (as by `Object.is`).
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

  let(expr: string, keyword: "const" | "let" = "const"): string {
    const v = `v${this.vars++}`;
    this.line(`${keyword} ${v} = ${expr};`);
    return v;
  }

  /** @returns A new variable, declared at the start of the function. */
  hoist(): string {
    const v = `h${this.hoisted.length}`;
    this.hoisted.push(v);
    return v;
  }

  line(code: string): void {
    this.lines.push(code);
  }

  /**
   * @param k A number of bytes, or an expression of it.
   * @returns An expression of the offset `k` bytes after the position.
   */
  at(k: number | string = 0): string {
    if (typeof k === "string") {
      return this.pos ? `o + ${this.pos} + ${k}` : `o + ${k}`;
    }
    return this.pos + k ? `o + ${this.pos + k}` : "o";
  }

  /** @returns The read position in the slice's or backing DataView, by mode. */
  viewAt(): string {
    return this.mode === "buffer" ? `${this.at()} + base` : this.at();
  }

  available(n: number): boolean {
    return this.pos + n <= this.checked;
  }

  /**
   * Emits a bounds check of `n` more bytes, unless an earlier one covers
   * them: encoders grow the writer, and resumable decoders wait for input.
   *
   * @param n A number of bytes, or an expression of it.
   * @param run The fields of the bytes.
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

  skip(n: number | string): void {
    if (typeof n === "number") {
      this.pos += n;
    } else {
      this.flush();
      this.line(`o += ${n};`);
      this.checked = 0;
    }
  }

  seek(offset: string): void {
    this.flush();
    this.line(`o = ${offset};`);
    this.checked = 0;
  }

  flush(): void {
    if (!this.pos) return;
    this.line(`o += ${this.pos};`);
    this.checked -= this.pos;
    this.pos = 0;
  }

  /**
   * Positions inside and after the block are only known at run time.
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
   * @param count An expression of the number of iterations, or `undefined`
   *   to loop until the body breaks.
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
   * For a parser inlined at the position: its fields are its own, and it
   * sees those around it.
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
   * @returns The variable of the number of bytes after the position, once
   *   the input is final (decoders throw `MORE` before, resumable ones wait).
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
   * Calls a function that may throw (e.g. the user's): its errors are
   * located at the current field.
   *
   * @param fn The function to call.
   * @param args Expressions of its arguments.
   * @returns The variable holding its result.
   */
  callback(fn: (...args: never[]) => unknown, ...args: string[]): string {
    return this.callbackAt(this.at(), fn, ...args);
  }

  /**
   * For conversions: a failure is located at the start of the value, read
   * before.
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
   * @param failed An expression that is true if the value is wrong.
   * @param code The code of the `DecodeError` (when decoding).
   * @param detail An expression of the error's detail.
   * @param at An expression of the offset of the error.
   * @param sizes Whether it also guards sizes (sizing skips other checks).
   */
  check(
    failed: string,
    code: DecodeError["code"],
    detail: string,
    at = this.at(),
    sizes = false,
  ): void {
    if (this.mode === "size" && !sizes) return;
    const error = this.error(code, detail, at);
    this.line(
      `if (${failed}) throw ${code === "end-of-input" ? this.ending(error) : error};`,
    );
  }

  fail(code: DecodeError["code"], detail: string): void {
    this.line(`throw ${this.error(code, detail)};`);
  }

  private error(
    code: DecodeError["code"],
    detail: string,
    at = this.at(),
  ): string {
    return this.encoding
      ? `${this.k(encodeFailed)}(${detail}, ${this.path()})`
      : `new ${this.k(DecodeError)}(${JSON.stringify(code)}, ${detail}, ${at}, ${this.path()})`;
  }

  private ending(error: string): string {
    return `cur.final ? ${error} : ${this.k(MORE)}`;
  }

  /**
   * @param reads The fields to hold (by default, all of them).
   * @returns The variable of an object of the fields before the current one
   *   (and around the parser), for functions of them.
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

  build(result: string): Compiled {
    this.flush();
    const s = this.scope === undefined ? "" : `, ${this.scope}`;
    const base =
      this.mode === "buffer" && this.usesView ? ", base = buf.byteOffset" : "";
    const [head, setup, done] = this.encoding
      ? [
          `function encode(w, v${s})`,
          "let buf = w.bytes, dv = w.view, o = w.offset;",
          "w.offset = o;",
        ]
      : [
          `function${this.mode === "resume" ? "*" : ""} decode(cur${s})`,
          `${this.mode === "resume" ? "let" : "const"} buf = cur.bytes, dv = cur.view, end = cur.end${base};\nlet o = cur.offset;`,
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
   * @returns Statements reloading the buffer, which a stream or a growing
   *   writer (moving the offset) may have replaced.
   */
  reload(): string {
    return this.encoding
      ? "o = w.offset; buf = w.bytes; dv = w.view;"
      : "buf = cur.bytes; dv = cur.view; end = cur.end;";
  }

  /**
   * @param statement A statement whose errors are located at the current
   *   field.
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

function runEnded(
  start: number,
  end: number,
  run: Run,
  path: Path,
): DecodeError {
  for (const [name, from, until] of run) {
    if (start + until > end) {
      return ended(start + from, start + until, end, [...path, name]);
    }
  }
  return ended(start, start + run.at(-1)![2], end, path);
}

function encodeFailed(detail: string, path: Path): EncodeError {
  return encodingWithin(new EncodeError(detail), path);
}
