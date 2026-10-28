/**
 * Defines binopsy's formats, including the unchanged bench/parse.ts record schema.
 * @param binopsy The imported library.
 * @param name Scenario name.
 * @param small Use the validation array length.
 * @returns The codec.
 */
export function schema(binopsy, name, small = false) {
  const { bin, bits, array, bytes, string, match, u8, u16le, u32le } = binopsy;
  const point = () => bin().f32le("x").f32le("y").u16le("id");
  switch (name) {
    case "header": {
      return bin()
        .u32le("magic")
        .u16le("version")
        .u16le("flags")
        .u32le("length")
        .u32le("sequence");
    }
    case "bits": {
      // Historical builds keep their original API for interleaved A/B runs.
      const field = (parser, key, width) =>
        bits === undefined
          ? parser.bits(key, width)
          : parser.field(key, bits(width));
      let parser = bin();
      for (const [key, width] of [
        ["version", 3],
        ["flags", 5],
        ["length", 12],
        ["kind", 4],
      ]) {
        parser = field(parser, key, width);
      }
      return parser.u16le("sequence");
    }
    case "numeric": {
      return bin().field("values", array(u32le, small ? 8 : 4096));
    }
    case "text": {
      return bin()
        .field("short", string({ terminator: 0 }))
        .field("medium", string({ terminator: 0 }))
        .field("long", string({ terminator: 0 }));
    }
    case "points": {
      return bin().field("points", array(point(), u16le));
    }
    case "union": {
      return bin()
        .u8("tag")
        .field(
          "data",
          match("tag")
            .case(0, bin().u32le("sequence"))
            .case(1, point())
            .case(2, bin().field("message", string(u32le))),
        );
    }
    case "record": {
      return bin()
        .u32le("rowId")
        .u8("cls")
        .field("ratings", array(u16le, 5))
        .field("club", bin().u32le("row").u32le("uid"))
        .field("attributes", array(u8, 69))
        .field("name", string(u32le))
        .field("fullName", string(u32le))
        .field(
          "items",
          array(bin().u8("kind").u16le("a").u32le("b").i8("c").f32le("d"), u8),
        )
        .u8("hasExtra")
        .field(
          "extra",
          match("hasExtra")
            .case(0, bin())
            .case(1, bin().u32le("x").field("y", bytes(12))),
        )
        .field("history", array(u8, u32le))
        .f64le("value")
        .u32le("uniqueId");
    }
    default: {
      throw new Error(`Unknown scenario ${name}`);
    }
  }
}
