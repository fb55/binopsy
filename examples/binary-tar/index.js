"use strict";

const Parser = require("binary-serializer");

// Copied from node-tar
const RECORDTYPES = {
  0: "File",
  "\0": "File", // Like 0
  "": "File",
  1: "Link",
  2: "SymbolicLink",
  3: "CharacterDevice",
  4: "BlockDevice",
  5: "Directory",
  6: "FIFO",
  7: "File", // Like 0
  // Posix headers
  g: "GlobalExtendedHeader", // K=v for the rest of the archive
  x: "ExtendedHeader", // K=v for the next file
  // Vendor-specific stuff
  A: "SolarisACL", // Skip
  D: "GNUDumpDir", // Like 5, but with data, which should be skipped
  I: "Inode", // Metadata only, skip
  K: "NextFileHasLongLinkpath", // Data = link path of next file
  L: "NextFileHasLongPath", // Data = path of next file
  M: "ContinuationFile", // Skip
  N: "OldGnuLongPath", // Like L
  S: "SparseFile", // Skip
  V: "TapeVolumeHeader", // Skip
  X: "OldExtendedHeader", // Like x
};

const CHECK_SUM_FILLER = Buffer.from("        ");

const TarRecord = Parser.start()
  .string("name", { length: 100, encoding: "ascii", stripNull: true })
  .string("mode", octalOpts(8))
  .string("uid", octalOpts(8))
  .string("gid", octalOpts(8))
  .string("size", octalOpts(12))
  .string("mtime", octalOpts(12))
  .buffer("checksum", {
    length: 8,
    deformatter(checksum, obj) {
      if (checksum) return checksum;

      // Calculate checksum
      const preSerialized = TarRecord.serialize({
        __proto__: obj,
        checksum: CHECK_SUM_FILLER,
      });

      checksum = 0;

      for (let i = 0; i < 512; i++) {
        checksum += preSerialized.readUInt8(i);
      }

      const checksumStr = checksum.toString(8);
      const checksumBuffer = Buffer.from("000000\0 ");
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
  .string("magic", { length: 6, encoding: "ascii" /* Assert: 'ustar\0'*/ })
  .string("version", { length: 2, encoding: "ascii" /* Assert: '00'*/ })
  .string("uname", { length: 32, encoding: "ascii", stripNull: true })
  .string("gname", { length: 32, encoding: "ascii", stripNull: true })
  .string("devmajor", octalOpts(8))
  .string("devminor", octalOpts(8))
  .string("prefix", { length: 167, encoding: "ascii", stripNull: true })
  .buffer("data", { length: "size" })
  .buffer("padding", {
    length() {
      return (512 - (this.size % 512)) % 512;
    },
    deformatter(padding, obj) {
      return padding || Buffer.alloc((512 - (obj.data.length % 512)) % 512);
    },
  });

const TarFile = Parser.start().array("entries", {
  type: TarRecord,
  readUntil: "eof",
});

module.exports = {
  File: TarFile,
  Record: TarRecord,
};

function octalOpts(length) {
  return {
    length,
    encoding: "ascii",
    formatter(str) {
      return parseInt(str.slice(0, -1), 8);
    },
    deformatter(num) {
      let str = num.toString(8);

      // Padding
      while (str.length < length - 1) str = `0${str}`;

      return `${str} `;
    },
  };
}

function mapFormatter(map) {
  const inverse = Object.create(null);

  for (const k in map) {
    if (!(map[k] in inverse)) inverse[map[k]] = k;
  }

  return {
    formatter(val) {
      if (!(val in map)) throw new Error(`value not present in map: ${val}`);
      return map[val];
    },
    deformatter(key) {
      if (!(key in inverse)) throw new Error(`key not present in map: ${key}`);
      return inverse[key];
    },
  };
}
