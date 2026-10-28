/**
 * Types only: the raw values of a codec, for `enumOf` to prove that a table
 * names them all. Only `bits(1)` to `bits(5)` have one (at most 32 values);
 * their outputs remain `number`.
 */
export declare const domain: unique symbol;
/** Codec `C`, whose raw values are `D`. */
export type WithDomain<C, D> = C & { readonly [domain]: D };
/** The raw values of codec `C`, or `unknown` if they are not known. */
export type Domain<C> = C extends { readonly [domain]: infer D } ? D : unknown;

type Range<N extends number, T extends number[] = []> = T["length"] extends N
  ? T[number]
  : Range<N, [...T, T["length"]]>;
/** The values of `bits(1)` to `bits(5)`, by width. */
export type BitDomain = {
  1: Range<2>;
  2: Range<4>;
  3: Range<8>;
  4: Range<16>;
  5: Range<32>;
};
