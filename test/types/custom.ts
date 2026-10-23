import { custom, bin, type Output, type Input } from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
export const byte = custom({
  size: 1,
  decode: (b) => (b.length ? { value: b[0]!, bytesRead: 1 } : undefined),
  encode: (n: number) => Uint8Array.of(n),
});
expect<Equal<Output<typeof byte>, number>>();
expect<Equal<Input<typeof byte>, number>>();
export const decoder = custom({
  decode: (b) => ({ value: b.length, bytesRead: b.length }),
});
// @ts-expect-error no encoder provided
decoder.encode(1);
// @ts-expect-error custom codec has no flattenable field plan
bin().merge(custom({ decode: () => ({ value: { x: 1 }, bytesRead: 1 }) }));
