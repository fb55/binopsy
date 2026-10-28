/// <reference types="node" />
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { schema } from "./schemas.mjs";

const src = process.argv[5];
export const binopsy = await import(
  src
    ? pathToFileURL(
        `${src}/index.${existsSync(`${src}/index.js`) ? "js" : "ts"}`,
      ).href
    : "../../lib/index.js"
);

export const binopsySchema = (name, small = false) =>
  schema(binopsy, name, small);
