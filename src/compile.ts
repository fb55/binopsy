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
import {
  DecodeError,
  ALL_FIELDS,
  EncodeError,
  encodingWithin,
  within,
  type AnyCodec,
  type Cursor,
  type Path,
  type Reads,
  type Writer,
} from "./codec.ts";

/** What a parser decodes: every field, none (it only steps over the value), or the named ones. */
export type Selection = "all" | "none" | ReadonlySet<string>;

export type Mode = "decode" | "resume" | "encode";

export type Decoder = (cur: Cursor, scope?: object) => unknown;
export type Encoder = (w: Writer, value: unknown, scope?: object) => void;
type Compiled = (...args: never[]) => unknown;

/** Compiled functions, by mode, whether they get the fields around them, codec and selection. */
const caches = new Map<string, WeakMap<AnyCodec, Map<Selection, Compiled>>>();
/** The cache entries added while compiling, which are removed if compiling fails. */
let added: [Map<Selection, Compiled>, Selection][] | undefined;

/** Whether `codec` reads fields around it (so its function gets them). */
export function scoped(codec: AnyCodec): boolean {
  return codec.reads.length > 0;
}

/**
 * The function for `codec` in `mode` (decoding `selection`), compiled on
 * first use; that of a codec `inner` to a parser gets its fields, if it reads them.
 */
export function compile(
  codec: AnyCodec,
  mode: "encode",
  selection?: "all",
  inner?: boolean,
): Encoder;
export function compile(
  codec: AnyCodec,
  mode: "decode" | "resume",
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
  if (!bySelection) byCodec.set(codec, (bySelection = new Map()));
  const cached = bySelection.get(selection);
  if (cached) return cached;

  const outermost = !added;
  added ??= [];
  // A codec that contains itself (through `lazy`) calls this stub until it is built.
  bySelection.set(
    selection,
    mode === "resume"
      ? function* (...args: never[]) {
          return yield* fn(...args) as Generator<number>;
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
      if (missing !== undefined)
        throw new Error(`\`${missing}\` is not a field before it`);
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
  /** The object holding the fields around the parser, if it gets them. */
  readonly scope: string | undefined;
  /** The field being emitted (for errors). */
  field: string | undefined;
  /** Variables of the array indexes inside the field. */
  private readonly indexes: string[] = [];
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

  /** The name of a constant holding `value`. */
  k(value: unknown): string {
    // (Keys of maps are equal as with `===`, which -0 is to 0.)
    const key = Object.is(value, -0) ? NEGATIVE_ZERO : value;
    let name = this.consts.get(key);
    if (!name) this.consts.set(key, (name = `k${this.consts.size}`));
    return name;
  }

  /** A new variable holding `expr`. */
  let(expr: string, keyword: "const" | "let" = "const"): string {
    const v = `v${this.vars++}`;
    this.line(`${keyword} ${v} = ${expr};`);
    return v;
  }

  /** A new variable, declared at the start of the function. */
  hoist(): string {
    const v = `h${this.hoisted.length}`;
    this.hoisted.push(v);
    return v;
  }

  line(code: string): void {
    this.lines.push(code);
  }

  /** The offset `k` bytes after the current position. */
  at(k: number | string = 0): string {
    if (typeof k === "string")
      return this.pos ? `o + ${this.pos} + ${k}` : `o + ${k}`;
    return this.pos + k ? `o + ${this.pos + k}` : "o";
  }

  /** Whether a previous bounds check already covers `n` bytes at this position. */
  available(n: number): boolean {
    return this.pos + n <= this.checked;
  }

  /**
   * Ensures that `n` more bytes can be read (or written); `run` names the
   * fields they belong to, for errors.
   */
  need(n: number | string, run?: Run): void {
    if (typeof n === "number") {
      if (this.pos + n <= this.checked) return;
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
    } else if (run) {
      this.line(
        `if (${reach} > end) throw ${this.k(runEnded)}(${this.at()}, end, ${this.k(run)}, ${this.path()});`,
      );
    } else {
      this.line(
        `if (${reach} > end) throw ${this.k(ended)}(${this.at()}, ${reach}, end, ${this.path()});`,
      );
    }
  }

  /** Moves past `n` bytes. */
  skip(n: number | string): void {
    if (typeof n === "number") {
      this.pos += n;
    } else {
      this.flush();
      this.line(`o += ${n};`);
      this.checked = 0;
    }
  }

  /** Moves to `offset`. */
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

  /** Emits `head { body tail`; positions inside and after it are only known at run time. */
  block(head: string, body: () => void, tail = "}"): void {
    this.flush();
    this.checked = 0;
    this.line(`${head} {`);
    body();
    this.flush();
    this.line(tail);
    this.checked = 0;
  }

  /** Emits a loop over an index from 0 to `count` (without one, until the body breaks). */
  loop(count: string | undefined, body: (i: string) => void): void {
    const i = `i${this.vars++}`;
    const test = count === undefined ? "" : ` ${i} < ${count}`;
    this.block(`for (let ${i} = 0;${test}; ${i}++)`, () => {
      this.indexes.push(i);
      body(i);
      this.indexes.pop();
    });
  }

  /**
   * Emits a call of the function of `codec` at the current position:
   * decoding (`wanted` or not) or encoding `value`; returns the value.
   */
  call(codec: AnyCodec, arg: boolean | string): string {
    const scope = scoped(codec) ? `, ${this.context(codec.reads)}` : "";
    this.flush();
    let v = "";
    if (this.mode === "encode") {
      const fn = this.k(compile(codec, "encode", "all", true));
      this.line("w.offset = o;");
      this.guard(`${fn}(w, ${arg as string}${scope});`);
      this.line(this.reload());
    } else {
      const fn = this.k(compile(codec, this.mode, arg ? "all" : "none", true));
      v = this.let("undefined", "let");
      this.line("cur.offset = o;");
      this.guard(
        `${v} = ${this.mode === "resume" ? "yield* " : ""}${fn}(cur${scope});`,
      );
      this.line(
        `o = cur.offset;${this.mode === "resume" ? ` ${this.reload()}` : ""}`,
      );
    }
    this.checked = 0;
    return arg === true ? v : "";
  }

  /**
   * Emits a call decoding `codec` (if `wanted`) in the next `n` bytes, which
   * are available: it may not read past them, and they are skipped after it.
   */
  region(n: number | string, codec: AnyCodec, wanted: boolean): string {
    const fn = this.k(compile(codec, "decode", wanted ? "all" : "none", true));
    const scope = scoped(codec) ? `, ${this.context(codec.reads)}` : "";
    this.flush();
    const [start, end, final, v] = [
      this.let("o"),
      this.let("cur.end"),
      this.let("cur.final"),
      this.let("undefined", "let"),
    ];
    this.line(`cur.offset = o; cur.end = o + ${n}; cur.final = true;`);
    this.guard(
      `${v} = ${fn}(cur${scope});`,
      `cur.end = ${end}; cur.final = ${final};`,
    );
    this.seek(`${start} + ${n}`);
    return wanted ? v : "";
  }

  /** Emits code waiting for the end of the input; returns the number of bytes left. */
  rest(): string {
    this.line(
      this.mode === "resume"
        ? `while (!cur.final) { yield Infinity; ${this.reload()} }`
        : `if (!cur.final) throw new ${this.k(DecodeError)}("end-of-input", "waiting for end of input", ${this.at()}, ${this.path()});`,
    );
    return this.let(`end - ${this.at()}`);
  }

  /** Emits a call of a function (of the user's, or one that may throw); returns its value. */
  callback(fn: (...args: never[]) => unknown, ...args: string[]): string {
    return this.callbackAt(this.at(), fn, ...args);
  }

  /** Calls a function whose failure belongs to the value beginning at `at`. */
  callbackAt(
    at: string,
    fn: (...args: never[]) => unknown,
    ...args: string[]
  ): string {
    const v = this.let("undefined", "let");
    this.guard(`${v} = ${this.k(fn)}(${args.join(", ")});`, undefined, at);
    return v;
  }

  /** Emits a check that fails if `failed` holds (decoding: at offset `at`). */
  check(
    failed: string,
    code: DecodeError["code"],
    detail: string,
    at = this.at(),
  ): void {
    const error =
      this.mode === "encode"
        ? `${this.k(encodeFailed)}(${detail}, ${this.path()})`
        : `new ${this.k(DecodeError)}(${JSON.stringify(code)}, ${detail}, ${at}, ${this.path()})`;
    this.line(`if (${failed}) throw ${error};`);
  }

  /** An object of the fields before the current one (and around the parser), for callbacks. */
  context(reads: Reads = [ALL_FIELDS]): string {
    const named = new Map<string, string>();
    for (const name of reads) {
      if (name !== ALL_FIELDS) named.set(name, this.ref(name));
    }
    const all = reads.includes(ALL_FIELDS);
    const entries = [...(all ? this.fields : named)].map(
      ([name, v]) => `${JSON.stringify(name)}: ${v}`,
    );
    if (all && this.scope) entries.unshift(`...${this.scope}`);
    return this.let(`{ ${entries.join(", ")} }`);
  }

  /** The expression of field `name` (of the parser, or around it). */
  ref(name: string): string {
    const v = this.fields.get(name);
    if (v !== undefined) return v;
    if (this.scope) return `${this.scope}[${JSON.stringify(name)}]`;
    throw new Error(
      `\`${name}\` is not a field before ${this.field === undefined ? "it" : `\`${this.field}\``}`,
    );
  }

  /** Builds the function; decoders return `result`. */
  build(result: string): Compiled {
    this.flush();
    const s = this.scope ? `, ${this.scope}` : "";
    const [head, setup, done] =
      this.mode === "encode"
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
      ...(this.hoisted.length ? [`let ${this.hoisted.join(", ")};`] : []),
      ...this.lines,
      done,
      "};",
    ].join("\n");
    const values = [...this.consts.keys()].map((key) =>
      key === NEGATIVE_ZERO ? -0 : key,
    );
    return new Function("K", source)(values) as Compiled;
  }

  /** Statements reloading the buffer, which the stream or a growing writer (moving the offset) may have replaced. */
  reload(): string {
    return this.mode === "encode"
      ? "o = w.offset; buf = w.bytes; dv = w.view;"
      : "buf = cur.bytes; dv = cur.view; end = cur.end;";
  }

  /** Emits a statement whose errors are located at the current field (and then runs `always`). */
  guard(statement: string, always?: string, at = this.at()): void {
    const located =
      this.mode === "encode"
        ? `${this.k(encodingWithin)}(e, ${this.path()})`
        : `${this.k(within)}(e, ${at}, ${this.path()})`;
    const end = always ? ` finally { ${always} }` : "";
    this.line(`try { ${statement} } catch (e) { throw ${located}; }${end}`);
  }

  /** The location of the current field, as an array expression. */
  path(): string {
    const field = this.field === undefined ? [] : [JSON.stringify(this.field)];
    return `[${[...field, ...this.indexes].join(", ")}]`;
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

/** The end of input within a run of fields starting at `start`: in the first field it cuts. */
function runEnded(
  start: number,
  end: number,
  run: Run,
  path: Path,
): DecodeError {
  let from = start;
  for (const [name, until] of run) {
    if (start + until > end)
      return ended(from, start + until, end, [...path, name]);
    from = start + until;
  }
  return ended(start, start + run[run.length - 1][1], end, path);
}

function encodeFailed(detail: string, path: Path): EncodeError {
  return encodingWithin(new EncodeError(detail), path);
}
