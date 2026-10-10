import { PRIMITIVE_TYPES, type PrimitiveName } from "./primitive-types.ts";
import type { ResolvedType, TypeLike } from "./types.ts";

class DefaultConstructor {}

function primitiveType(name: PrimitiveName): ResolvedType {
  const { size, read, write } = PRIMITIVE_TYPES[name];

  return {
    constructorFn: DefaultConstructor,
    fixedSize: size,
    bitRequests: [],
    sizeFunc: () => size,
    writeFunc(val, buf) {
      return (buf[write] as (value: unknown, offset?: number) => number)(val);
    },
    readFunc(read_, _obj, cb) {
      read_(size, (buf, offset, done) => {
        cb(
          read_,
          done ? null : (buf[read] as (offset: number) => unknown)(offset),
          done,
        );
      });
    },
  };
}

const TYPE_FUNCTIONS = Object.fromEntries(
  (Object.keys(PRIMITIVE_TYPES) as PrimitiveName[]).map((name) => [
    name,
    primitiveType(name),
  ]),
) as Record<PrimitiveName, ResolvedType>;

function isTypeLike(type: unknown): type is TypeLike {
  if (typeof type !== "object" || type === null) return false;
  const t = type as Partial<TypeLike>;
  return (
    typeof t.sizeFunc === "function" &&
    typeof t.writeFunc === "function" &&
    typeof t.readFunc === "function"
  );
}

/**
 * Resolves a primitive name or a parser into the functions used for nested
 * reading and writing. Unless `keepBitfield` is set, pending bit fields of a
 * nested parser are flushed first.
 */
export function getType(type: unknown, keepBitfield = false): ResolvedType {
  if (typeof type === "string") {
    if (Object.prototype.hasOwnProperty.call(TYPE_FUNCTIONS, type)) {
      return TYPE_FUNCTIONS[type as PrimitiveName];
    }

    throw new Error(`unsupported primitive type ${type}`);
  } else if (!isTypeLike(type)) {
    throw new Error("type needs to be either a primitive or a binary parser");
  } else if (!keepBitfield && type._flushBitfield) {
    type._flushBitfield();
  }

  // Create copy to speed up choices
  return {
    constructorFn: type.constructorFn,
    fixedSize: type.fixedSize,
    bitRequests: type.bitRequests,
    sizeFunc: type.sizeFunc,
    writeFunc: type.writeFunc,
    readFunc: type.readFunc,
  };
}
