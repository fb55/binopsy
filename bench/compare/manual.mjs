/** Hand-written DataView reference. No schema dispatch inside array loops, no validation. */
import { Buffer } from "node:buffer";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();
export const textSize = (s) => Buffer.byteLength(s);
export const bufferOf = (v) => Buffer.from(v);

/**
 * Makes a hand-written codec for a workload. Strings use standard UTF-8 APIs.
 * @param name The scenario.
 * @returns An encoder and decoder.
 */
export function manual(name) {
  return {
    decode(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let o = 0;
      const text = () => {
        const n = dv.getUint32(o, true);
        o += 4;
        const s = decoder.decode(bytes.subarray(o, o + n));
        o += n;
        return s;
      };
      const cstring = () => {
        const end = bytes.indexOf(0, o);
        const s = decoder.decode(bytes.subarray(o, end));
        o = end + 1;
        return s;
      };
      const points = (n) => {
        const a = [];
        for (let k = 0; k < n; k++) {
          a.push({
            x: dv.getFloat32(o, true),
            y: dv.getFloat32(o + 4, true),
            id: dv.getUint16(o + 8, true),
          });
          o += 10;
        }
        return a;
      };
      switch (name) {
        case "header": {
          return {
            magic: dv.getUint32(0, true),
            version: dv.getUint16(4, true),
            flags: dv.getUint16(6, true),
            length: dv.getUint32(8, true),
            sequence: dv.getUint32(12, true),
          };
        }
        case "bits": {
          return {
            version: bytes[0] >>> 5,
            flags: bytes[0] & 31,
            length: (bytes[1] << 4) | (bytes[2] >>> 4),
            kind: bytes[2] & 15,
            sequence: dv.getUint16(3, true),
          };
        }
        case "numeric": {
          const values = [];
          for (let k = 0; k < bytes.length; k += 4) {
            values.push(dv.getUint32(k, true));
          }
          return { values };
        }
        case "text": {
          return { short: cstring(), medium: cstring(), long: cstring() };
        }
        case "points": {
          const n = dv.getUint16(0, true);
          o = 2;
          return { points: points(n) };
        }
        case "union": {
          const tag = bytes[0];
          o = 1;
          return {
            tag,
            data:
              tag === 0
                ? { sequence: dv.getUint32(1, true) }
                : tag === 1
                  ? points(1)[0]
                  : { message: text() },
          };
        }
        case "record": {
          const rowId = dv.getUint32(0, true);
          const cls = bytes[4];
          const ratings = [];
          for (let k = 5; k < 15; k += 2) ratings.push(dv.getUint16(k, true));
          const club = {
            row: dv.getUint32(15, true),
            uid: dv.getUint32(19, true),
          };
          const attributes = [];
          for (let k = 23; k < 92; k++) attributes.push(bytes[k]);
          o = 92;
          const nameValue = text();
          const fullName = text();
          const n = bytes[o++];
          const items = [];
          for (let k = 0; k < n; k++) {
            items.push({
              kind: bytes[o],
              a: dv.getUint16(o + 1, true),
              b: dv.getUint32(o + 3, true),
              c: dv.getInt8(o + 7),
              d: dv.getFloat32(o + 8, true),
            });
            o += 12;
          }
          const hasExtra = bytes[o++];
          let extra = {};
          if (hasExtra === 1) {
            extra = {
              x: dv.getUint32(o, true),
              y: bytes.subarray(o + 4, o + 16),
            };
            o += 16;
          }
          const count = dv.getUint32(o, true);
          o += 4;
          const history = [];
          for (let k = 0; k < count; k++) history.push(bytes[o++]);
          return {
            rowId,
            cls,
            ratings,
            club,
            attributes,
            name: nameValue,
            fullName,
            items,
            hasExtra,
            extra,
            history,
            value: dv.getFloat64(o, true),
            uniqueId: dv.getUint32(o + 8, true),
          };
        }
        default: {
          throw new Error(`Unknown scenario ${name}`);
        }
      }
    },
    encode(value) {
      const size = encodedSize(name, value);
      const bytes = new Uint8Array(size);
      const dv = new DataView(bytes.buffer);
      let o = 0;
      const text = (s) => {
        const n = textSize(s);
        dv.setUint32(o, n, true);
        o += 4;
        encoder.encodeInto(s, bytes.subarray(o));
        o += n;
      };
      const cstring = (s) => {
        o += encoder.encodeInto(s, bytes.subarray(o)).written;
        bytes[o++] = 0;
      };
      const point = (p) => {
        dv.setFloat32(o, p.x, true);
        dv.setFloat32(o + 4, p.y, true);
        dv.setUint16(o + 8, p.id, true);
        o += 10;
      };
      switch (name) {
        case "header": {
          dv.setUint32(0, value.magic, true);
          dv.setUint16(4, value.version, true);
          dv.setUint16(6, value.flags, true);
          dv.setUint32(8, value.length, true);
          dv.setUint32(12, value.sequence, true);
          break;
        }
        case "bits": {
          bytes[0] = (value.version << 5) | value.flags;
          bytes[1] = value.length >>> 4;
          bytes[2] = (value.length << 4) | value.kind;
          dv.setUint16(3, value.sequence, true);
          break;
        }
        case "numeric": {
          for (const v of value.values) {
            dv.setUint32(o, v, true);
            o += 4;
          }
          break;
        }
        case "text": {
          cstring(value.short);
          cstring(value.medium);
          cstring(value.long);
          break;
        }
        case "points": {
          dv.setUint16(0, value.points.length, true);
          o = 2;
          for (const p of value.points) point(p);
          break;
        }
        case "union": {
          bytes[o++] = value.tag;
          if (value.tag === 0) dv.setUint32(o, value.data.sequence, true);
          else if (value.tag === 1) point(value.data);
          else text(value.data.message);
          break;
        }
        case "record": {
          dv.setUint32(0, value.rowId, true);
          bytes[4] = value.cls;
          o = 5;
          for (const v of value.ratings) {
            dv.setUint16(o, v, true);
            o += 2;
          }
          dv.setUint32(15, value.club.row, true);
          dv.setUint32(19, value.club.uid, true);
          bytes.set(value.attributes, 23);
          o = 92;
          text(value.name);
          text(value.fullName);
          bytes[o++] = value.items.length;
          for (const v of value.items) {
            bytes[o] = v.kind;
            dv.setUint16(o + 1, v.a, true);
            dv.setUint32(o + 3, v.b, true);
            dv.setInt8(o + 7, v.c);
            dv.setFloat32(o + 8, v.d, true);
            o += 12;
          }
          bytes[o++] = value.hasExtra;
          if (value.hasExtra === 1) {
            dv.setUint32(o, value.extra.x, true);
            bytes.set(value.extra.y, o + 4);
            o += 16;
          }
          dv.setUint32(o, value.history.length, true);
          o += 4;
          bytes.set(value.history, o);
          o += value.history.length;
          dv.setFloat64(o, value.value, true);
          dv.setUint32(o + 8, value.uniqueId, true);
          break;
        }
        default: {
          throw new Error(`Unknown scenario ${name}`);
        }
      }
      return bytes;
    },
  };
}

/**
 * Computes the independent reference size.
 * @param name Scenario.
 * @param value Value.
 * @returns Byte count.
 */
function encodedSize(name, value) {
  let size;
  switch (name) {
    case "header": {
      size = 16;
      break;
    }
    case "bits": {
      size = 5;
      break;
    }
    case "numeric": {
      size = value.values.length * 4;
      break;
    }
    case "text": {
      size =
        textSize(value.short) +
        textSize(value.medium) +
        textSize(value.long) +
        3;
      break;
    }
    case "points": {
      size = 2 + value.points.length * 10;
      break;
    }
    case "union": {
      size =
        value.tag === 0
          ? 5
          : value.tag === 1
            ? 11
            : 5 + textSize(value.data.message);
      break;
    }
    case "record": {
      size =
        118 +
        textSize(value.name) +
        textSize(value.fullName) +
        value.items.length * 12 +
        (value.hasExtra === 1 ? 16 : 0) +
        value.history.length;
      break;
    }
    default: {
      throw new Error(`Unknown scenario ${name}`);
    }
  }

  return size;
}
