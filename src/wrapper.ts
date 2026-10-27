/** Conversions and checks that can also surround a packed bit field. */
import { Codec, type AnyCodec } from "./codec.ts";
import type { Gen } from "./compile.ts";

/** Shared scalar conversions, including packed fields. @internal */
export abstract class Wrapper extends Codec<
  unknown,
  unknown,
  unknown,
  boolean
> {
  declare readonly packing?: NonNullable<AnyCodec["packing"]>;
  protected readonly inner: AnyCodec;

  constructor(inner: AnyCodec, checks = false) {
    super(inner.size, checks || inner.checks, inner.reads);
    this.inner = inner;
    const { packing } = inner;
    if (packing) {
      // Inherit the run layout and raw reader; only the conversions differ.
      this.packing = Object.assign(Object.create(packing) as typeof packing, {
        decodeValue: (
          g: Gen,
          raw: string,
          wanted: boolean,
          at: string,
        ): string =>
          this.readValue(
            g,
            packing.decodeValue
              ? packing.decodeValue(g, raw, wanted || checks, at)
              : raw,
            at,
            wanted,
          ),
        encodeValue: (g: Gen, value: string): string => {
          const raw = this.writeValue(g, value);
          return packing.encodeValue ? packing.encodeValue(g, raw) : raw;
        },
      });
    }
  }

  protected abstract readValue(
    g: Gen,
    raw: string,
    at: string,
    wanted: boolean,
  ): string;
  protected abstract writeValue(g: Gen, value: string): string;

  emitWrite(g: Gen, value: string): void {
    this.inner.emitWrite(g, this.writeValue(g, value));
  }
}
