/** Workloads fixed before tuning: wire formats and deterministic, varied values. */
export const names = [
  "header",
  "record",
  "union",
  "bits",
  "numeric",
  "text",
  "points",
];

/**
 * Creates one value, also used for independent reference bytes.
 * @param name The workload.
 * @param i The sample index.
 * @param small Whether to use a small numeric array for startup verification.
 * @returns The canonical value.
 */
export function sample(name, i, small = false) {
  switch (name) {
    case "header": {
      return {
        magic: 0x504f5342,
        version: 1 + (i % 4),
        flags: i & 0xffff,
        length: i * 23,
        sequence: i,
      };
    }
    case "record": {
      return {
        rowId: i,
        cls: 2,
        ratings: [1, 2, 3, 4, 5],
        club: { row: i % 1000, uid: i * 13 },
        attributes: Array.from({ length: 69 }, (_, k) => (i + k) % 21),
        name: `Player ${i}`,
        fullName: `Some Fairly Long Full Name ${i}`,
        items: Array.from({ length: i % 7 }, (_, k) => ({
          kind: k,
          a: i & 0xffff,
          b: i * 7,
          c: -3,
          d: 1.5,
        })),
        hasExtra: i % 3 === 0 ? 1 : 0,
        extra: i % 3 === 0 ? { x: i, y: new Uint8Array(12).fill(1) } : {},
        history: Array.from({ length: i % 5 }, (_, k) => k),
        value: i * 1.25,
        uniqueId: i * 31,
      };
    }
    case "union": {
      const tag = i % 3;
      return {
        tag,
        data:
          tag === 0
            ? { sequence: i }
            : tag === 1
              ? { x: i / 4, y: -i / 2, id: i & 0xffff }
              : { message: `Event ${i}: café 東京` },
      };
    }
    case "bits": {
      return {
        version: i & 7,
        flags: i & 31,
        length: i & 4095,
        kind: i & 15,
        sequence: i & 0xffff,
      };
    }
    case "numeric": {
      return {
        values: Array.from(
          { length: small ? 8 : 4096 },
          (_, k) => (Math.imul(i + 1, 2_654_435_761) + k * 65_537) >>> 0,
        ),
      };
    }
    case "text": {
      return {
        short: `name${i}`,
        medium:
          i % 2
            ? `A message in UTF-8: café 東京 ${i}`
            : `An ordinary ASCII message ${i}`,
        long: `${"A paragraph with punctuation, numbers 123, and text. ".repeat(5)}${i}`,
      };
    }
    case "points": {
      return {
        points: Array.from({ length: 50 }, (_, k) => ({
          x: k / 2,
          y: i / 4,
          id: k,
        })),
      };
    }
    default: {
      throw new Error(`Unknown scenario ${name}`);
    }
  }
}

/**
 * A small observable result from every decoded value; identical work across libraries.
 * @param name The scenario.
 * @param value The native decoded value.
 * @returns A number accumulated by the timing loop.
 */
export function observe(name, value) {
  switch (name) {
    case "header": {
      return value.sequence;
    }
    case "record": {
      return value.uniqueId;
    }
    case "union": {
      return value.tag ?? value.TAG ?? value.version;
    }
    case "bits": {
      return value.sequence;
    }
    case "numeric": {
      return value.values[0] + value.values.at(-1);
    }
    case "text": {
      return value.long.length;
    }
    case "points": {
      return value.points.at(-1).id;
    }
    default: {
      throw new Error(`Unknown scenario ${name}`);
    }
  }
}
