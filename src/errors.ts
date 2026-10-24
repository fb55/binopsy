/** Errors of decoding and encoding, located by the path of a field (and an offset). */

/** Where a value is: field names and array indexes. */
export type Path = readonly (string | number)[];

/** Thrown by decoders reaching the end of input that is not final (no error: more input is needed). */
export const MORE = Symbol("more");

/**
 * A path as written in code, e.g. `items[1].name` or `["a b"]`.
 *
 * @param path The field names and array indexes.
 * @returns The path as code, or "" if it is empty.
 */
function where(path: Path): string {
  return path
    .map((p, i) =>
      typeof p === "number"
        ? `[${p}]`
        : /^[A-Za-z_$][\w$]*$/u.test(p)
          ? i
            ? `.${p}`
            : p
          : `[${JSON.stringify(p)}]`,
    )
    .join("");
}

/**
 * The message of a failure: its detail, and where it is.
 *
 * @param detail The failure, without its location.
 * @param path The field names and array indexes of the value that failed.
 * @param offset The offset of the value that failed (none when encoding).
 * @returns The detail, followed by the path (if any) and the offset (if any).
 */
function located(detail: string, path: Path, offset?: number): string {
  const at = path.length > 0 ? ` in \`${where(path)}\`` : "";
  return offset === undefined
    ? `${detail}${at}`
    : `${detail}${at} at offset ${offset}`;
}

/**
 * The message of a thrown value.
 *
 * @param e The thrown value.
 * @returns Its message if it is an `Error`, else it converted to a string.
 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Why decoding failed, where (`path` of field names and array indexes), and at which byte. */
export class DecodeError extends Error {
  override name = "DecodeError";
  /** What failed: truncated input, an invalid value, a tag without a case, or an error thrown by a function. */
  readonly code: "end-of-input" | "invalid" | "no-match" | "error";
  /** The failure, without its location. */
  readonly detail: string;
  /** The offset of the value that failed. */
  readonly offset: number;
  /** The field names and array indexes of the value that failed. */
  readonly path: Path;

  constructor(
    code: DecodeError["code"],
    detail: string,
    offset: number,
    path: Path = [],
    cause?: unknown,
  ) {
    super(located(detail, path, offset), { cause });
    this.code = code;
    this.detail = detail;
    this.offset = offset;
    this.path = [...path];
  }
}

/** Why encoding failed, and where (`path` of field names and array indexes). */
export class EncodeError extends Error {
  override name = "EncodeError";
  /** The failure, without its location. */
  readonly detail: string;
  /** The field names and array indexes of the value that failed. */
  readonly path: Path = [];

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
    [...path, ...e.path],
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
  err.path = [...path, ...(own ? e.path : [])];
  err.message = located(err.detail, err.path);
  return err;
}
