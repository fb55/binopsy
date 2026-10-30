/** Where a value is: field names and array indexes, e.g. `["items", 3, "name"]`. */
export type Path = readonly (string | number)[];

/** Thrown by decoders reaching the end of input that is not final (no error: more input is needed). */
export const MORE = Symbol("more");

const identifier = /^[A-Za-z_$][\w$]*$/u;

// The text of the paths that errors own, which are frozen (unlike arrays
// given to them): an error rethrown by each level of a deep value extends
// the text of the one below instead of writing it all again.
const written = new WeakMap<Path, string>();

/**
 * @param path Field names and array indexes.
 * @returns The path as written in code, e.g. `items[1].name` or `["a b"]`.
 */
function where(path: Path): string {
  return (
    written.get(path) ??
    path
      .map((p, i) =>
        typeof p === "number"
          ? `[${p}]`
          : identifier.test(p)
            ? i
              ? `.${p}`
              : p
            : `[${JSON.stringify(p)}]`,
      )
      .join("")
  );
}

/**
 * @param outer The location of a value.
 * @param inner A location within that value.
 * @returns The joined path, with its text written from both.
 */
function nested(outer: Path, inner: Path): Path {
  const path = Object.freeze([...outer, ...inner]);
  const [first] = inner;
  const dot =
    outer.length > 0 && typeof first === "string" && identifier.test(first);
  written.set(path, `${where(outer)}${dot ? "." : ""}${where(inner)}`);
  return path;
}

/**
 * @param detail The failure, without its location.
 * @param path The path of the value that failed, as written.
 * @param offset The offset of the value that failed (none when encoding).
 * @returns The detail, followed by the path (if any) and the offset (if any).
 */
function located(detail: string, path: string, offset?: number): string {
  const at = path ? ` in \`${path}\`` : "";
  return offset === undefined
    ? `${detail}${at}`
    : `${detail}${at} at offset ${offset}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Why decoding failed, in which field (`path`), and at which byte (`offset`).
 * The `message` is the `detail` with its location: ``unexpected end of input
 * (10 bytes needed, 4 left) in `chunks[1].data` at offset 41``.
 */
export class DecodeError extends Error {
  override name = "DecodeError";
  /**
   * What failed: `"end-of-input"` (the input ends inside the value),
   * `"invalid"` (a value failed a check, e.g. of a literal), `"no-match"` (a
   * tag without a case), or `"error"` (a function of yours threw: its error
   * is the `cause`).
   */
  readonly code: "end-of-input" | "invalid" | "no-match" | "error";
  /** The failure, without its location. */
  readonly detail: string;
  /** The offset of the value that failed, in the input. */
  readonly offset: number;
  /** The field names and array indexes of the value that failed. */
  readonly path: Path;

  /**
   * A decoding error, e.g. for a `custom` decoder to throw.
   *
   * @param code What failed (see `code`).
   * @param detail The failure, without its location.
   * @param offset The offset of the value that failed. Thrown by a `custom`
   *   decoder, it is in the bytes the decoder got (binopsy moves it to the
   *   input's).
   * @param path Where the value is, in the value being decoded (binopsy
   *   adds the path of the field in front).
   * @param cause The error that caused it, if any.
   */
  constructor(
    code: DecodeError["code"],
    detail: string,
    offset: number,
    path: Path = [],
    cause?: unknown,
  ) {
    const text = where(path);
    super(located(detail, text, offset), { cause });
    this.code = code;
    this.detail = detail;
    this.offset = offset;
    this.path = Object.freeze([...path]);
    written.set(this.path, text);
  }
}

/**
 * Why encoding failed, and in which field (`path`). The `message` is the
 * `detail` with its location: ``expected u8, got 300 in `name` ``. Errors
 * that your functions throw while encoding become `EncodeError`s with the
 * error as their `cause`.
 */
export class EncodeError extends Error {
  override name = "EncodeError";
  /** The failure, without its location. */
  readonly detail: string;
  /** The field names and array indexes of the value that failed. */
  readonly path: Path = Object.freeze([]);

  /**
   * An encoding error (binopsy adds the path of the field that failed).
   *
   * @param detail The failure, without its location.
   * @param cause The error that caused it, if any.
   */
  constructor(detail: string, cause?: unknown) {
    super(detail, { cause });
    this.detail = detail;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Locates a `DecodeError` at `path` (in front of its own) and moves it by
 * `shift`; other errors become `DecodeError`s at `offset` (and `MORE` stays).
 *
 * @param e The thrown value.
 * @param offset The offset of the value that failed (for other errors).
 * @param path The location of the value that failed.
 * @param shift The number of bytes to add to the offset of a `DecodeError`.
 * @returns A new `DecodeError`, or `MORE`.
 */
export function within(
  e: unknown,
  offset: number,
  path: Path,
  shift = 0,
): unknown {
  if (e === MORE) return e;
  if (!(e instanceof DecodeError)) {
    return new DecodeError("error", messageOf(e), offset, path, e);
  }
  return new DecodeError(
    e.code,
    e.detail,
    e.offset + shift,
    nested(path, e.path),
    e.cause,
  );
}

/**
 * Like `within`, for encoding.
 *
 * @param e The thrown value.
 * @param path The location of the value that failed.
 * @returns A new `EncodeError` at `path` (followed by the error's own path).
 */
export function encodingWithin(e: unknown, path: Path): EncodeError {
  const own = e instanceof EncodeError;
  const err = new EncodeError(
    own ? e.detail : messageOf(e),
    own ? e.cause : e,
  ) as Mutable<EncodeError>;
  err.path = own ? nested(path, e.path) : Object.freeze([...path]);
  err.message = located(err.detail, where(err.path));
  return err;
}
