/* eslint-disable */
import {
  bin,
  bytes,
  sized,
  array,
  string,
  optional,
  when,
  custom,
  map,
  refine,
  match,
  literal,
  u8,
  Reader,
  decodeStream,
  DecodeError,
  EncodeError,
  type Codec,
  type Context,
  type Input,
  type Output,
  type Path,
  type Struct,
} from "../../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expect<T extends true>(): T | void {}

// Named reads remain checked through a bounded nested field plan.
const dependent = bin<{ count: number }>().field("value", bytes("count"));
const nested = bin().u8("count").field("region", sized(4, dependent));
expect<
  Equal<Output<typeof nested>, { count: number; region: { value: Uint8Array } }>
>();
// @ts-expect-error outer count is required
bin().field("region", sized(4, dependent));
// @ts-expect-error Reader only accepts standalone codecs
new Reader(new Uint8Array()).read(dependent);
// @ts-expect-error Streams only accept standalone codecs
decodeStream(dependent, []);

// A typed callback is a real static requirement even though its annotation is erased.
const callback = bytes((o: { count?: number }) => o.count ?? 0);
expect<Equal<Context<typeof callback>, { count?: number }>>();
// @ts-expect-error explicit optional context is still a context requirement
callback.decode(new Uint8Array());

const nullable = custom({
  size: 1,
  decode: () => ({ value: null, bytesRead: 1 }),
  encode: (_value: null) => Uint8Array.of(0),
});
expect<Equal<Input<ReturnType<typeof optional<null, null>>>, null>>();
optional(u8, nullable).encode(null);
const conditional = bin().u8("flag").field("value", when("flag", nullable));
expect<Equal<Input<typeof conditional>, { flag: number; value: null }>>();
conditional.encode({ flag: 0, value: null });
// Flag/value agreement is intentionally a runtime check.
conditional.encode({ flag: 1, value: null });

// Numeric prefix codecs may be mapped/refined, provided they accept number inputs.
const positive = refine(u8, (n) => n > 0);
const mapped = map(u8, { decode: (n) => n * 2, encode: (n) => n / 2 });
sized(positive, bytes(Infinity));
sized(mapped, bytes(Infinity));
string(u8, { terminator: 0 });
string(Infinity, { padRight: 0 });

// Finished plans are selectable/mergeable but no longer builders.
const computed = bin()
  .u8("count")
  .field("items", array(u8, "count"))
  .computed("count", (value) => value.items.length);
const selected: Struct<{ count: number }, never> = computed.pick("count");
bin().merge(selected);
// @ts-expect-error terminal computation removes builder methods
computed.u8("tail");
// @ts-expect-error selected plans have no encoding input
selected.encode({ count: 1 });

// Public data and locations are readonly; implementation members stay hidden.
const error = new DecodeError(
  "invalid",
  "bad value",
  0,
  ["a.b", 1],
  new Error(),
);
const path: Path = error.path;
void path;
// @ts-expect-error readonly location
error.offset = 1;
// @ts-expect-error readonly path
error.path.push("x");
const encodingError = new EncodeError("bad value", error);
void encodingError.cause;
// @ts-expect-error machine-readable failure codes belong to DecodeError only
encodingError.code;
const reader = new Reader(new Uint8Array());
// @ts-expect-error readonly cursor position
reader.offset = 1;
// @ts-expect-error private implementation cursor is absent
reader.bytes;
// @ts-expect-error no public compiler operations
u8.read;
const plain: Codec<{ value: number }> = bin().u8("value");
// @ts-expect-error the annotation erases the field plan
bin().merge(plain);

// Same named discriminant composes through a second direct match.
const multi = bin()
  .u8("tag")
  .field("a", match("tag").case(1, u8).case(2, string(1)))
  .field("b", match("tag").case(1, string(1)).case(2, u8));
expect<
  Equal<
    Output<typeof multi>,
    { tag: 1; a: number; b: string } | { tag: 2; a: string; b: number }
  >
>();
const defaults = bin()
  .field("tag", literal(u8, 1))
  .field("value", match("tag").case(1, literal(u8, 2)));
defaults.encode({});
