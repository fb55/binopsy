"use strict";

const fs = require("fs");
const tar = require("./");
const path = require("path");

const file = fs.createWriteStream(path.resolve(process.argv[2]));

process.argv
  .slice(3)
  .map((n) => path.resolve(n))
  .forEach(read);

function read(p) {
  if (p.endsWith(".DS_Store")) return;

  console.log("PACKING", p);

  const stat = fs.statSync(p);

  const record = {
    name: path.relative(process.cwd(), p),
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: 0,
    mtime: Math.floor(stat.mtime / 1000),
    linkname: "",
    magic: "ustar\0",
    version: "00",
    uname: "", // TODO
    gname: "", // TODO
    devmajor: 0,
    devminor: 0,
    prefix: "",

    type: null,
    data: Buffer.alloc(0),
  };

  if (stat.isDirectory()) {
    record.type = "Directory";
  } else if (stat.isFile()) {
    record.type = "File";

    const contents = fs.readFileSync(p);

    record.size = contents.length;
    record.data = contents;
  } else {
    throw new Error("Unsupported type");
  }

  file.write(tar.Record.serialize(record));

  if (stat.isDirectory()) {
    fs.readdirSync(p)
      .map((n) => path.resolve(p, n))
      .forEach(read);
  }
}
