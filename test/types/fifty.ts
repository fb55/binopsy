import {
  bin,
  match,
  u8,
  string,
  type Output,
  type Input,
} from "../../src/index.ts";
export const fifty = bin()
  .u8("tag")
  .field(
    "body",
    match("tag")
      .case(0, u8)
      .case(1, string(1))
      .case(2, u8)
      .case(3, string(1))
      .case(4, u8)
      .case(5, string(1))
      .case(6, u8)
      .case(7, string(1))
      .case(8, u8)
      .case(9, string(1))
      .case(10, u8)
      .case(11, string(1))
      .case(12, u8)
      .case(13, string(1))
      .case(14, u8)
      .case(15, string(1))
      .case(16, u8)
      .case(17, string(1))
      .case(18, u8)
      .case(19, string(1))
      .case(20, u8)
      .case(21, string(1))
      .case(22, u8)
      .case(23, string(1))
      .case(24, u8)
      .case(25, string(1))
      .case(26, u8)
      .case(27, string(1))
      .case(28, u8)
      .case(29, string(1))
      .case(30, u8)
      .case(31, string(1))
      .case(32, u8)
      .case(33, string(1))
      .case(34, u8)
      .case(35, string(1))
      .case(36, u8)
      .case(37, string(1))
      .case(38, u8)
      .case(39, string(1))
      .case(40, u8)
      .case(41, string(1))
      .case(42, u8)
      .case(43, string(1))
      .case(44, u8)
      .case(45, string(1))
      .case(46, u8)
      .case(47, string(1))
      .case(48, u8)
      .case(49, string(1)),
  )
  .u8("tail");
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}
type Expected =
  | { tag: 0; body: number; tail: number }
  | { tag: 1; body: string; tail: number }
  | { tag: 2; body: number; tail: number }
  | { tag: 3; body: string; tail: number }
  | { tag: 4; body: number; tail: number }
  | { tag: 5; body: string; tail: number }
  | { tag: 6; body: number; tail: number }
  | { tag: 7; body: string; tail: number }
  | { tag: 8; body: number; tail: number }
  | { tag: 9; body: string; tail: number }
  | { tag: 10; body: number; tail: number }
  | { tag: 11; body: string; tail: number }
  | { tag: 12; body: number; tail: number }
  | { tag: 13; body: string; tail: number }
  | { tag: 14; body: number; tail: number }
  | { tag: 15; body: string; tail: number }
  | { tag: 16; body: number; tail: number }
  | { tag: 17; body: string; tail: number }
  | { tag: 18; body: number; tail: number }
  | { tag: 19; body: string; tail: number }
  | { tag: 20; body: number; tail: number }
  | { tag: 21; body: string; tail: number }
  | { tag: 22; body: number; tail: number }
  | { tag: 23; body: string; tail: number }
  | { tag: 24; body: number; tail: number }
  | { tag: 25; body: string; tail: number }
  | { tag: 26; body: number; tail: number }
  | { tag: 27; body: string; tail: number }
  | { tag: 28; body: number; tail: number }
  | { tag: 29; body: string; tail: number }
  | { tag: 30; body: number; tail: number }
  | { tag: 31; body: string; tail: number }
  | { tag: 32; body: number; tail: number }
  | { tag: 33; body: string; tail: number }
  | { tag: 34; body: number; tail: number }
  | { tag: 35; body: string; tail: number }
  | { tag: 36; body: number; tail: number }
  | { tag: 37; body: string; tail: number }
  | { tag: 38; body: number; tail: number }
  | { tag: 39; body: string; tail: number }
  | { tag: 40; body: number; tail: number }
  | { tag: 41; body: string; tail: number }
  | { tag: 42; body: number; tail: number }
  | { tag: 43; body: string; tail: number }
  | { tag: 44; body: number; tail: number }
  | { tag: 45; body: string; tail: number }
  | { tag: 46; body: number; tail: number }
  | { tag: 47; body: string; tail: number }
  | { tag: 48; body: number; tail: number }
  | { tag: 49; body: string; tail: number };
expect<Equal<Output<typeof fifty>, Expected>>();
expect<Equal<Input<typeof fifty>, Expected>>();
