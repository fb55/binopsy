import { Codec, type AnyCodec } from "./codec.ts";
import type { Gen } from "./compile.ts";

/** Conversions and checks of another codec's values, which may be a bit field. @internal */
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

  emitRead(g: Gen, wanted: boolean): string {
    // A value that is not wanted is only read if a check needs it.
    if (!wanted && !this.checks) return this.inner.emitRead(g, false);
    const at = g.let(g.at());
    return this.readValue(g, this.inner.emitRead(g, true), at, wanted);
  }

  /**
   * Emits the checks and conversion of a decoded inner value.
   *
   * @param g The generator of the function.
   * @param raw An expression of the inner value.
   * @param at An expression of the offset of the value, for errors.
   * @param wanted Whether the value is decoded (a wrapper that checks values
   *   checks them either way).
   * @returns An expression of the value, or "" if it is not wanted.
   */
  protected abstract readValue(
    g: Gen,
    raw: string,
    at: string,
    wanted: boolean,
  ): string;
  /**
   * Emits the checks and conversion of a value to encode.
   *
   * @param g The generator of the function.
   * @param value The variable holding the value.
   * @returns An expression of the inner value to write.
   */
  protected abstract writeValue(g: Gen, value: string): string;

  emitWrite(g: Gen, value: string): void {
    this.inner.emitWrite(g, this.writeValue(g, value));
  }
}
