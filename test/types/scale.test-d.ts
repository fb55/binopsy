import { describe, expectTypeOf, it } from "vitest";

import {
  bin,
  bytes,
  match,
  string,
  u8,
  type Input,
  type Output,
} from "../../src/index.ts";

/*
 * These parsers are far larger than usual: they catch changes to the types
 * that make checking fail, or slow it down, as parsers grow.
 */

// oxfmt-ignore
const Chained = bin()
  .u8("n0").u8("n1").u8("n2").u8("n3").u8("n4").u8("n5").u8("n6").u8("n7").u8("n8").u8("n9")
  .u8("n10").u8("n11").u8("n12").u8("n13").u8("n14").u8("n15").u8("n16").u8("n17").u8("n18").u8("n19")
  .u8("n20").u8("n21").u8("n22").u8("n23").u8("n24").u8("n25").u8("n26").u8("n27").u8("n28").u8("n29")
  .u8("n30").u8("n31").u8("n32").u8("n33").u8("n34").u8("n35").u8("n36").u8("n37").u8("n38").u8("n39")
  .u8("n40").u8("n41").u8("n42").u8("n43").u8("n44").u8("n45").u8("n46").u8("n47").u8("n48").u8("n49")
  .u8("n50").u8("n51").u8("n52").u8("n53").u8("n54").u8("n55").u8("n56").u8("n57").u8("n58").u8("n59")
  .u8("n60").u8("n61").u8("n62").u8("n63").u8("n64").u8("n65").u8("n66").u8("n67").u8("n68").u8("n69")
  .u8("n70").u8("n71").u8("n72").u8("n73").u8("n74").u8("n75").u8("n76").u8("n77").u8("n78").u8("n79")
  .u8("n80").u8("n81").u8("n82").u8("n83").u8("n84").u8("n85").u8("n86").u8("n87").u8("n88").u8("n89")
  .u8("n90").u8("n91").u8("n92").u8("n93").u8("n94").u8("n95").u8("n96").u8("n97").u8("n98").u8("n99")
  .field("body", bytes((o) => o.n0 + o.n99));

// oxfmt-ignore
const Merged = bin()
  .merge(bin()
    .u8("n0").u8("n1").u8("n2").u8("n3").u8("n4").u8("n5").u8("n6").u8("n7").u8("n8").u8("n9")
    .u8("n10").u8("n11").u8("n12").u8("n13").u8("n14").u8("n15").u8("n16").u8("n17").u8("n18").u8("n19")
    .u8("n20").u8("n21").u8("n22").u8("n23").u8("n24").u8("n25").u8("n26").u8("n27").u8("n28").u8("n29")
    .u8("n30").u8("n31").u8("n32").u8("n33").u8("n34").u8("n35").u8("n36").u8("n37").u8("n38").u8("n39"))
  .merge(bin()
    .u8("n40").u8("n41").u8("n42").u8("n43").u8("n44").u8("n45").u8("n46").u8("n47").u8("n48").u8("n49")
    .u8("n50").u8("n51").u8("n52").u8("n53").u8("n54").u8("n55").u8("n56").u8("n57").u8("n58").u8("n59")
    .u8("n60").u8("n61").u8("n62").u8("n63").u8("n64").u8("n65").u8("n66").u8("n67").u8("n68").u8("n69")
    .u8("n70").u8("n71").u8("n72").u8("n73").u8("n74").u8("n75").u8("n76").u8("n77").u8("n78").u8("n79"))
  .merge(bin()
    .u8("n80").u8("n81").u8("n82").u8("n83").u8("n84").u8("n85").u8("n86").u8("n87").u8("n88").u8("n89")
    .u8("n90").u8("n91").u8("n92").u8("n93").u8("n94").u8("n95").u8("n96").u8("n97").u8("n98").u8("n99")
    .u8("n100").u8("n101").u8("n102").u8("n103").u8("n104").u8("n105").u8("n106").u8("n107").u8("n108").u8("n109")
    .u8("n110").u8("n111").u8("n112").u8("n113").u8("n114").u8("n115").u8("n116").u8("n117").u8("n118").u8("n119"))
  .merge(bin()
    .u8("n120").u8("n121").u8("n122").u8("n123").u8("n124").u8("n125").u8("n126").u8("n127").u8("n128").u8("n129")
    .u8("n130").u8("n131").u8("n132").u8("n133").u8("n134").u8("n135").u8("n136").u8("n137").u8("n138").u8("n139")
    .u8("n140").u8("n141").u8("n142").u8("n143").u8("n144").u8("n145").u8("n146").u8("n147").u8("n148").u8("n149")
    .u8("n150").u8("n151").u8("n152").u8("n153").u8("n154").u8("n155").u8("n156").u8("n157").u8("n158").u8("n159"))
  .field("body", bytes((o) => o.n0 + o.n159));

// oxfmt-ignore
const Fifty = bin()
  .u8("tag")
  .field(
    "body",
    match("tag")
      .case(0, u8).case(1, string(1)).case(2, u8).case(3, string(1)).case(4, u8)
      .case(5, string(1)).case(6, u8).case(7, string(1)).case(8, u8).case(9, string(1))
      .case(10, u8).case(11, string(1)).case(12, u8).case(13, string(1)).case(14, u8)
      .case(15, string(1)).case(16, u8).case(17, string(1)).case(18, u8).case(19, string(1))
      .case(20, u8).case(21, string(1)).case(22, u8).case(23, string(1)).case(24, u8)
      .case(25, string(1)).case(26, u8).case(27, string(1)).case(28, u8).case(29, string(1))
      .case(30, u8).case(31, string(1)).case(32, u8).case(33, string(1)).case(34, u8)
      .case(35, string(1)).case(36, u8).case(37, string(1)).case(38, u8).case(39, string(1))
      .case(40, u8).case(41, string(1)).case(42, u8).case(43, string(1)).case(44, u8)
      .case(45, string(1)).case(46, u8).case(47, string(1)).case(48, u8).case(49, string(1)),
  )
  .u8("tail");

describe("Large parsers", () => {
  it("of a hundred chained fields read the first and the last", () => {
    expectTypeOf<Output<typeof Chained>["n0"]>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof Chained>["n99"]>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof Chained>["body"]>().toEqualTypeOf<Uint8Array>();
  });

  it("of a hundred and sixty merged fields read the first and the last", () => {
    expectTypeOf<Output<typeof Merged>["n0"]>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof Merged>["n159"]>().toEqualTypeOf<number>();
    expectTypeOf<Output<typeof Merged>["body"]>().toEqualTypeOf<Uint8Array>();
  });

  it("of a match of fifty cases give a union of fifty variants", () => {
    type FiftyT = Output<typeof Fifty>;
    expectTypeOf<Input<typeof Fifty>>().toEqualTypeOf<FiftyT>();
    expectTypeOf<
      number extends FiftyT["tag"] ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<Extract<FiftyT, { tag: 7 }>>().toEqualTypeOf<{
      tag: 7;
      body: string;
      tail: number;
    }>();
    expectTypeOf<Extract<FiftyT, { tag: 48 }>>().toEqualTypeOf<{
      tag: 48;
      body: number;
      tail: number;
    }>();
  });
});
