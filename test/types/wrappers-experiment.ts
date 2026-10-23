import {
  bin,
  bytes,
  array,
  optional,
  when,
  sized,
  map,
  refine,
  u8,
} from "../../src/index.ts";
export const nestedArray = bin()
  .u8("size")
  .u8("count")
  .field(
    "items",
    array(
      bytes((o) => o.size),
      "count",
    ),
  );
export const nestedOptional = bin()
  .u8("size")
  .field(
    "body",
    optional(
      u8,
      bytes((o) => o.size),
    ),
  );
export const nestedWhen = bin()
  .u8("size")
  .field(
    "body",
    when(
      (o) => o.size > 0,
      bytes((o) => o.size),
    ),
  );
export const nestedSized = bin()
  .u8("size")
  .field(
    "body",
    sized(
      "size",
      bytes((o) => o.size),
    ),
  );
export const nestedMap = bin()
  .u8("size")
  .field(
    "body",
    map(
      bytes((o) => o.size),
      { decode: (b) => b, encode: (b) => b },
    ),
  );
export const nestedRefine = bin()
  .u8("size")
  .field(
    "body",
    refine(
      bytes((o) => o.size),
      (b) => b.length > 0,
    ),
  );
