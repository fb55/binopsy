const PRIMITIVE_TYPES = require("./primitive_types.json");

module.exports = getType;

const TYPE_FUNCTIONS = {};

Object.keys(PRIMITIVE_TYPES).forEach((key) => {
  const readKey = `read${key}`;
  const writeKey = `write${key}`;
  const size = PRIMITIVE_TYPES[key];

  TYPE_FUNCTIONS[key.toLowerCase()] = {
    constructorFn: class DefaultConstructor {},
    fixedSize: size,
    bitRequests: [],
    sizeFunc() {
      return size;
    },
    writeFunc(val, buf) {
      return buf[writeKey](val);
    },
    readFunc(read, obj, cb) {
      read(size, (buf, offset, done) => {
        cb(read, done ? null : buf[readKey](offset), done);
      });
    },
  };
});

function getType(type, keepBitfield) {
  if (typeof type === "string") {
    if (type in TYPE_FUNCTIONS) {
      return TYPE_FUNCTIONS[type];
    }

    throw new Error(`unsupported primitive type ${type}`);
  } else if (
    typeof type !== "object" ||
    type === null ||
    typeof type.sizeFunc !== "function" ||
    typeof type.writeFunc !== "function" ||
    typeof type.readFunc !== "function"
  ) {
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
