/* eslint-disable */
// No fourth Bin parameter is needed for defined literal/computed defaults.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
type Resolved<I> = I extends unknown
  ? {
      [K in keyof I]-?: {} extends Pick<I, K> ? Exclude<I[K], undefined> : I[K];
    }
  : never;
type Sample = {
  literal?: 2 | undefined;
  plain: number | undefined;
  readonly computed?: string;
};
expect<
  Equal<
    Resolved<Sample>,
    { literal: 2; plain: number | undefined; readonly computed: string }
  >
>();
// For undefined-valued computations, optionality alone would be insufficient.
type OptionalUndefined = { value?: undefined };
expect<Equal<Resolved<OptionalUndefined>, { value: never }>>();
// A separate resolution state could represent this; current computed callbacks require defined results.
type WithIndependentState<I, R> = { input: I; resolved: R };
type CanRepresentUndefined = WithIndependentState<
  OptionalUndefined,
  { value: undefined }
>;
expect<Equal<CanRepresentUndefined["resolved"], { value: undefined }>>();
export {};
