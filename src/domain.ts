/** Bounded, type-only raw domains; ordinary numeric outputs remain `number`. */
export declare const domain: unique symbol;
export type WithDomain<C, D> = C & { readonly [domain]: D };
export type Domain<C> = C extends { readonly [domain]: infer D } ? D : unknown;

type Range<N extends number, T extends number[] = []> = T["length"] extends N
  ? T[number]
  : Range<N, [...T, T["length"]]>;
type Negative<N extends number> = `-${N}` extends `${infer V extends number}`
  ? V
  : never;
type U7 = Range<128>;
export type U8 = Range<256>;
export type I8 = U7 | Negative<Exclude<Range<129>, 0>>;
export type BitDomain = {
  1: Range<2>;
  2: Range<4>;
  3: Range<8>;
  4: Range<16>;
  5: Range<32>;
  6: Range<64>;
  7: U7;
  8: U8;
};
