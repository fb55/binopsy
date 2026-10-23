import { bin, match } from "../../src/index.ts";

/*
 * Duplicate-field validation is a runtime definition check, including this
 * otherwise well-typed schema. Keep the construction out of executed fixtures.
 */
export function runtimeRejected() {
  return bin()
    .u8("tag")
    .merge(match("tag").case(1, bin().u8("x")).case(2, bin().u8("y")))
    .merge(match("tag").case(1, bin().u8("z")).case(2, bin().u8("x")));
}

const aligned = bin()
  .bits("a", 1)
  .merge(
    bin()
      .bits("b", 1)
      .computed("b", () => 1),
  );
export const size: number = aligned.size;
// @ts-expect-error The API promises no type-level byte-count literal.
export const inferredSize: 1 = aligned.size;
