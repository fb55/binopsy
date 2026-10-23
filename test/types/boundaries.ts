/* eslint-disable */
import {
  bin,
  bytes,
  array,
  lazy,
  map,
  match,
  optional,
  when,
  refine,
  sized,
  u8,
  Reader,
  decodeStream,
  type Bin,
  type Codec,
  type Context,
  type Input,
  type Output,
} from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
declare const base: Bin<
  | { readonly kind: 1; note?: string; a: number }
  | { readonly kind: 2; note?: string; b: number }
>;
export const variants = base.field(
  "body",
  match("kind").case(1, u8).case(2, bytes(1)),
);
expect<
  Equal<
    Output<typeof variants>,
    | { readonly kind: 1; note?: string; a: number; body: number }
    | { readonly kind: 2; note?: string; b: number; body: Uint8Array }
  >
>();
export const selected = variants.pick("kind", "note");
expect<
  Equal<
    Output<typeof selected>,
    { readonly kind: 1; note?: string } | { readonly kind: 2; note?: string }
  >
>();
export const nestedTwice = bin()
  .u8("size")
  .u8("count")
  .field(
    "data",
    sized(
      "size",
      array(
        optional(
          u8,
          bytes((o) => o.size),
        ),
        "count",
      ),
    ),
  );
export const conditioned = bin()
  .u8("size")
  .field(
    "data",
    when(
      (o) => o.size > 0,
      map(
        bytes((o) => o.size),
        { decode: (b) => b, encode: (b) => b },
      ),
    ),
  );
export const guarded = bin()
  .u8("size")
  .field(
    "data",
    refine(
      bytes((o) => o.size),
      (b) => b.length > 0,
    ),
  );
// @ts-expect-error lazy targets must be standalone
lazy(() => bytes("size"));
export const required = bin<{ size: number }>().field("data", bytes("size"));
// @ts-expect-error still dependent through a region
sized(4, required).decode(new Uint8Array());
// @ts-expect-error context gating in Reader
new Reader(new Uint8Array()).read(required.pick("data"));
// @ts-expect-error context gating in streams
decodeStream(required, []);
// @ts-expect-error implementation metadata has no string property
u8["~types"];
// @ts-expect-error internals not public
u8.decodeAt({});
// @ts-expect-error Codec is type-only
new Codec();
export interface Tree {
  children: Tree[];
}
export interface TreeInput {
  children: readonly TreeInput[];
}
export const Tree: Codec<Tree, TreeInput> = bin().field(
  "children",
  array(
    lazy(() => Tree),
    u8,
  ),
);
expect<Equal<Context<typeof Tree>, unknown>>();
expect<Equal<Input<typeof Tree>, TreeInput>>();
// An explicit any is still the language's escape hatch.
declare const AnyTag: Codec<any>;
export const escaped = bin()
  .field("tag", AnyTag)
  .field("body", match("tag").case("x", u8));
export const shadow = bin<{ count: number }>().field(
  "count",
  map(u8, { decode: (n) => String(n), encode: (s: string) => Number(s) }),
);
// @ts-expect-error local string shadows outer numeric count
shadow.field("data", bytes("count"));
