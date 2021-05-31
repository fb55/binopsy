"use strict";

var Parser = require("binary-serializer");

//copied from node-tar
var RECORDTYPES = {
  0: "File",
  "\0": "File", // like 0
  "": "File",
  1: "Link",
  2: "SymbolicLink",
  3: "CharacterDevice",
  4: "BlockDevice",
  5: "Directory",
  6: "FIFO",
  7: "File", // like 0
  // posix headers
  g: "GlobalExtendedHeader", // k=v for the rest of the archive
  x: "ExtendedHeader", // k=v for the next file
  // vendor-specific stuff
  A: "SolarisACL", // skip
  D: "GNUDumpDir", // like 5, but with data, which should be skipped
  I: "Inode", // metadata only, skip
  K: "NextFileHasLongLinkpath", // data = link path of next file
  L: "NextFileHasLongPath", // data = path of next file
  M: "ContinuationFile", // skip
  N: "OldGnuLongPath", // like L
  S: "SparseFile", // skip
  V: "TapeVolumeHeader", // skip
  X: "OldExtendedHeader", // like x
};

var CHECK_SUM_FILLER = new Buffer("        ");

var TarRecord = Parser.start()
  .string("name", { length: 100, encoding: "ascii", stripNull: true })
  .string("mode", octalOpts(8))
  .string("uid", octalOpts(8))
  .string("gid", octalOpts(8))
  .string("size", octalOpts(12))
  .string("mtime", octalOpts(12))
  .buffer("checksum", {
    length: 8,
    deformatter: function (checksum, obj) {
      if (checksum) return checksum;

      //calculate checksum
      var preSerialized = TarRecord.serialize({
        __proto__: obj,
        checksum: CHECK_SUM_FILLER,
      });

      var checksum = 0;

      for (var i = 0; i < 512; i++) {
        checksum += preSerialized.readUInt8(i);
      }

      var checksumStr = checksum.toString(8);
      var checksumBuffer = new Buffer("000000\0 ");
      checksumBuffer.write(checksumStr, 6 - checksumStr.length);

      return checksumBuffer;
    },
  })
  .string("type", {
    __proto__: mapFormatter(RECORDTYPES),
    length: 1,
    encoding: "ascii",
  })
  .string("linkname", { length: 100, encoding: "ascii", stripNull: true })
  .string("magic", { length: 6, encoding: "ascii" /*assert: 'ustar\0'*/ })
  .string("version", { length: 2, encoding: "ascii" /*assert: '00'*/ })
  .string("uname", { length: 32, encoding: "ascii", stripNull: true })
  .string("gname", { length: 32, encoding: "ascii", stripNull: true })
  .string("devmajor", octalOpts(8))
  .string("devminor", octalOpts(8))
  .string("prefix", { length: 167, encoding: "ascii", stripNull: true })
  .buffer("data", { length: "size" })
  .buffer("padding", {
    length: function () {
      return (512 - (this.size % 512)) % 512;
    },
    deformatter: function (padding, obj) {
      return padding || new Buffer((512 - (obj.data.length % 512)) % 512);
    },
  });

var TarFile = Parser.start().array("entries", {
  type: TarRecord,
  readUntil: "eof",
});

module.exports = {
  File: TarFile,
  Record: TarRecord,
};

function octalOpts(length) {
  return {
    length: length,
    encoding: "ascii",
    formatter: function (str) {
      return parseInt(str.slice(0, -1), 8);
    },
    deformatter: function (num) {
      var str = num.toString(8);

      //padding
      while (str.length < length - 1) str = "0" + str;

      return str + " ";
    },
  };
}

function mapFormatter(map) {
  var inverse = Object.create(null);

  for (var k in map) {
    if (!(map[k] in inverse)) inverse[map[k]] = k;
  }

  return {
    formatter: function (val) {
      if (!(val in map)) throw new Error("value not present in map: " + val);
      return map[val];
    },
    deformatter: function (key) {
      if (!(key in inverse)) throw new Error("key not present in map: " + key);
      return inverse[key];
    },
  };
}
