/**
 * Decoding streams: values may span any number of chunks. A value is
 * decoded with the codec's decoder if its chunk holds all of it, and else
 * with its resumable decoder, which continues as chunks arrive.
 */
import {
  DecodeError,
  viewOf,
  within,
  type AnyCodec,
  type Codec,
  type Cursor,
} from "./codec.ts";
import { compile, type Decoder } from "./compile.ts";

const EMPTY = new Uint8Array(0);
const MORE = Symbol("more");
const DONE = Object.freeze({ value: undefined, done: true as const });

type Chunks = AsyncIterator<Uint8Array> | Iterator<Uint8Array>;

/**
 * Decodes the values of `codec` in the chunks of `source` (any iterable or
 * async iterable of bytes, e.g. a Node.js or web stream). Stopping (with
 * `break`, or a failure) closes the source.
 */
export function decodeStream<O>(
  codec: Codec<O, never, unknown>,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterableIterator<O> {
  if (codec.size === 0)
    throw new TypeError("values of no bytes cannot be streamed");
  const chunks =
    Symbol.asyncIterator in source
      ? source[Symbol.asyncIterator]()
      : source[Symbol.iterator]();
  return new Values<O>(codec as AnyCodec, chunks);
}

/** The values of a stream; values in the chunks read so far are returned without waiting. */
class Values<O> implements AsyncIterableIterator<O> {
  private readonly decode: Decoder;
  private readonly resume: (cur: Cursor) => Generator<number, O>;
  private readonly chunks: Chunks;
  private readonly cur: Cursor = {
    bytes: EMPTY,
    view: viewOf(EMPTY),
    offset: 0,
    end: 0,
    final: false,
  };
  /** The position of `cur.bytes` in the stream. */
  private base = 0;
  /** A value continuing in later chunks, and the offset it needs to reach. */
  private pending: Generator<number, O> | undefined;
  private reach = 0;
  /** The buffer pending values are collected in (the only one written to). */
  private own = EMPTY;
  /** Calls of `next` waiting for chunks run one after the other. */
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private done = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(codec: AnyCodec, chunks: Chunks) {
    this.decode = compile(codec, "decode", "all");
    this.resume = compile(codec, "resume", "all") as (
      cur: Cursor,
    ) => Generator<number, O>;
    this.chunks = chunks;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<O, undefined>> {
    if (!this.waiting) {
      // A value in the chunks read so far: no need to wait.
      if (this.done) return Promise.resolve(DONE);
      try {
        const value = this.take();
        if (value !== MORE) return Promise.resolve({ value, done: false });
      } catch (e) {
        return this.fail(e);
      }
    }
    this.waiting++;
    const result = this.queue
      .then(() => this.step())
      .finally(() => this.waiting--);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async return(): Promise<IteratorResult<O, undefined>> {
    this.done = true;
    // After a chunk being waited for arrives (its values are dropped).
    await this.queue;
    await this.close();
    return DONE;
  }

  private async step(): Promise<IteratorResult<O, undefined>> {
    if (this.done) return DONE;
    try {
      for (;;) {
        const value = this.take();
        if (value !== MORE) return { value, done: false };
        if (this.cur.final) {
          this.done = true;
          return DONE;
        }
        let chunk;
        try {
          chunk = await this.chunks.next();
        } catch (e) {
          // Source errors keep their identity, but still close the source.
          return this.fail(e, false);
        }
        if (this.done) return DONE;
        // At the end, values reading up to the end of the input are complete.
        if (chunk.done) {
          this.cur.final = true;
          this.closed = true;
        } else this.add(chunk.value);
      }
    } catch (e) {
      return this.fail(e);
    }
  }

  /** Ends the iteration with decoding error `e` (with offsets in the stream), closing the source. */
  private async fail(e: unknown, decode = true): Promise<never> {
    this.done = true;
    const error =
      decode && e instanceof DecodeError ? within(e, 0, [], this.base) : e;
    // A failure closing the source does not hide this one.
    await this.close().catch(() => undefined);
    throw error;
  }

  /** Closes the source (once). */
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return (this.closing = Promise.resolve()
      .then(() => this.chunks.return?.())
      .then(() => undefined));
  }

  /** The next value in the chunks read so far, or `MORE`. */
  private take(): O | typeof MORE {
    const { cur } = this;
    if (this.pending) {
      while (cur.end >= this.reach || cur.final) {
        const step = this.pending.next();
        if (step.done) {
          this.pending = undefined;
          if (cur.offset === 0)
            throw new DecodeError("invalid", "a value took no bytes", 0);
          return step.value;
        }
        this.reach = step.value;
        // The input ended in the value: decoding it again locates the error (it starts at offset 0).
        if (cur.final) this.decode({ ...cur, offset: 0 });
      }
      return MORE;
    }
    const start = cur.offset;
    if (start === cur.end) return MORE;
    try {
      const value = this.decode(cur) as O;
      if (cur.offset === start)
        throw new DecodeError("invalid", "a value took no bytes", start);
      return value;
    } catch (e) {
      const more = e instanceof DecodeError && e.code === "end-of-input";
      if (!more || cur.final) throw e;
    }
    // The value continues in later chunks: decode it in a buffer of its own, which they are added to.
    cur.offset = start;
    this.base += start;
    this.use(cur.bytes.subarray(start, cur.end), cur.end - start);
    cur.offset = 0;
    this.pending = this.resume(cur);
    this.reach = 0;
    return this.take();
  }

  /** Adds a chunk: after the pending value's bytes, or instead of the bytes read. */
  private add(chunk: Uint8Array): void {
    const { cur } = this;
    if (!this.pending) {
      this.base += cur.end;
      this.use(chunk, chunk.length);
      cur.offset = 0;
      return;
    }
    // Bytes are only written past `cur.end`, where no decoded value refers to.
    const end = cur.end + chunk.length;
    if (cur.bytes !== this.own || end > this.own.length) {
      this.own = new Uint8Array(Math.max(end, 2 * cur.end, 4096));
      this.own.set(cur.bytes.subarray(0, cur.end));
    }
    this.own.set(chunk, cur.end);
    this.use(this.own, end);
  }

  private use(bytes: Uint8Array, end: number): void {
    this.cur.bytes = bytes;
    this.cur.view = viewOf(bytes);
    this.cur.end = end;
  }
}
