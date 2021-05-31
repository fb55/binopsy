const PRIMITIVE_TYPES = require("./primitive_types.json");

module.exports = getType;

const TYPE_FUNCTIONS = {};

Object.keys(PRIMITIVE_TYPES).forEach(function (key) {
  var readKey = "read" + key;
  var writeKey = "write" + key;
  var size = PRIMITIVE_TYPES[key];

  TYPE_FUNCTIONS[key.toLowerCase()] = {
    constructorFn: function () {},
    fixedSize: size,
    bitRequests: [],
    sizeFunc: function () {
      return size;
    },
    writeFunc: function (val, buf) {
      return buf[writeKey](val);
    },
    readFunc: function (read, obj, cb) {
      read(size, function (buf, offset, done) {
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

    throw new Error("unsupported primitive type " + type);
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

  // create copy to speed up choices
  return {
    constructorFn: type.constructorFn,
    fixedSize: type.fixedSize,
    bitRequests: type.bitRequests,
    sizeFunc: type.sizeFunc,
    writeFunc: type.writeFunc,
    readFunc: type.readFunc,
  };
}
