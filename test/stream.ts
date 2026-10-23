import assert from "node:assert/strict";
import { decodeStream, DecodeError, u8, u16le } from "../src/index.ts";

describe("Stream error and close paths", () => {
  it("rebases EOF errors after a complete record and stays done", async () => {
    const stream = decodeStream(u16le, [Uint8Array.of(1, 0), Uint8Array.of(2)]);
    assert.equal((await stream.next()).value, 1);
    await assert.rejects(
      stream.next(),
      (e) => e instanceof DecodeError && e.offset === 2,
    );
    assert.equal((await stream.next()).done, true);
  });

  it("closes failed sources and preserves their errors over cleanup failures", async () => {
    const primary = new DecodeError("error", "source", 77);
    let closed = 0;
    const stream = decodeStream(u8, {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            throw primary;
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            closed++;
            throw new Error("cleanup");
          },
        };
      },
    });
    await assert.rejects(stream.next(), (e) => e === primary);
    assert.equal(closed, 1);
    assert.equal(primary.offset, 77);
  });

  it("shares in-progress cleanup between concurrent returns", async () => {
    let finish!: () => void;
    let closed = 0;
    const stream = decodeStream(u8, {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { value: Uint8Array.of(1), done: false as const };
          },
          async return() {
            closed++;
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            return { value: undefined, done: true as const };
          },
        };
      },
    });
    const a = stream.return!();
    const b = stream.return!();
    let settled = false;
    void b.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
    assert.equal(settled, false);
    finish();
    await Promise.all([a, b]);
  });

  it("closes after a rejected outstanding pull raced by return", async () => {
    const primary = new Error("pull");
    let reject!: (e: Error) => void;
    let closed = 0;
    const stream = decodeStream(u8, {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((_resolve, no) => {
              reject = no;
            }),
          async return() {
            closed++;
            return { value: undefined, done: true as const };
          },
        };
      },
    });
    const next = stream.next();
    await new Promise((resolve) => setImmediate(resolve));
    const done = stream.return!();
    reject(primary);
    await assert.rejects(next, (e) => e === primary);
    await done;
    assert.equal(closed, 1);
  });
});
