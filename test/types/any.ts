// Every parser is an `AnyBin`.
import { bin, match, string, u8, type AnyBin } from "../../src/index.ts";
export const parsers: AnyBin[] = [
  bin().u8("a"),
  bin().u8("t").field("v", match("t").case(0, u8)),
  bin()
    .u8("n")
    .field("s", string("n"))
    .computed("n", (v) => v.s.length),
  bin().u8("n").pick("n"),
  bin<{ length: number }>().field("s", string("length")),
];
