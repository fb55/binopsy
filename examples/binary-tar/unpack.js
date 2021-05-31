"use strict";

const fs = require("fs");
const tar = require("./");
const path = require("path");
const mkdirp = require("mkdirp");

const file = fs.createReadStream(path.resolve(process.argv[2]));

file.pipe(tar.Record.stream()).on("data", function (d) {
  console.log("UNPACKING", d);

  if (d.name === "") {
    console.log("empty record");
    return;
  }

  switch (d.type) {
    case "File":
      fs.writeFileSync(path.resolve(d.name), d.data);
      break;
    case "Directory":
      mkdirp.sync(d.name);
      break;
    default:
      throw new Error("Unknown type " + d.type);
  }
});
