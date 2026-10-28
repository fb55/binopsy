import { describe, expectTypeOf, it } from "vitest";

import {
  array,
  bin,
  bytes,
  map,
  sized,
  string,
  u8,
  type Context,
  type Length,
} from "../../src/index.ts";

// Generic functions can pass lengths on.
export const genericLength = <T>(n: Length<T>) => sized(n, array(bytes(n), n));
export const genericString = <T>(n: Length<T>) => string(n);

describe("Lengths", () => {
  it("that may be one of several need everything any of them reads", () => {
    const Names = bytes(Math.random() ? "a" : "b");
    expectTypeOf<Context<typeof Names>>().toEqualTypeOf<{
      a: number;
      b: number;
    }>();
    const Forms = bytes(Math.random() ? 1 : "a");
    expectTypeOf<Context<typeof Forms>>().toEqualTypeOf<{ a: number }>();
    const Callbacks = bytes(
      Math.random() ? (o: { a: number }) => o.a : (o: { b: number }) => o.b,
    );
    expectTypeOf<Context<typeof Callbacks>>().toEqualTypeOf<
      { a: number } & { b: number }
    >();
    const maybeOptions = Math.random()
      ? 4
      : { terminator: 0, max: "limit" as const };
    const Options = string(maybeOptions);
    expectTypeOf<Context<typeof Options>>().toEqualTypeOf<{ limit: number }>();
    array(u8, Math.random() ? 4 : { until: (n: number) => n === 0 });
  });

  it("of terminated strings may be capped by a field or a function", () => {
    bin()
      .u8("limit")
      .field("s", string({ terminator: 0, max: "limit" }));
    bin()
      .u8("limit")
      .field("s", string({ terminator: 0, max: (o) => o.limit }));
  });
});

describe("Options", () => {
  it("are checked for unknown keys", () => {
    // @ts-expect-error `maxx` is not an option.
    string({ terminator: 0, maxx: 4 });
    // @ts-expect-error An array has a length or `until`, not both.
    array(u8, { until: (n) => n === 0, length: 4 });
  });

  it("with `until` need items that encode what they decode", () => {
    const UntilMapped = array(
      map(u8, { decode: (n) => ({ n }), encode: (n: number) => n }),
      { until: (o) => o.n === 0 },
    );
    // @ts-expect-error The items decode to objects but encode numbers.
    UntilMapped.encode([0]);
  });
});
