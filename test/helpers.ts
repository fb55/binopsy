import { Bin } from "../src/index.ts";

/** A length-prefixed string. */
export const Str = Bin.start().uint8("len").string("text", { length: "len" });

/** Bytes from hex digits (spaces are ignored). */
export function hex(text: string): Buffer {
  return Buffer.from(text.replace(/\s/g, ""), "hex");
}

/** Writes `chunks` to `parser.stream()` and collects the values it emits. */
export function collect<T extends object>(
  parser: Bin<T>,
  chunks: Buffer[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [];
    const stream = parser
      .stream()
      .on("data", (value: T) => values.push(value))
      .on("end", () => resolve(values))
      .on("error", reject);
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}
