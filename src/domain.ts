/** Type-only domains of at most 32 values; numeric outputs remain `number`. */
export declare const domain: unique symbol;
export type WithDomain<C, D> = C & { readonly [domain]: D };
export type Domain<C> = C extends { readonly [domain]: infer D } ? D : unknown;

type Range<N extends number, T extends number[] = []> = T["length"] extends N
  ? T[number]
  : Range<N, [...T, T["length"]]>;
export type BitDomain = {
  1: Range<2>;
  2: Range<4>;
  3: Range<8>;
  4: Range<16>;
  5: Range<32>;
};
