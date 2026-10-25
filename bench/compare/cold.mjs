/** Separate phases in a fresh process; fixtures never import binopsy. */
import { pathToFileURL } from "node:url";

import { manual } from "./manual.mjs";
import { sample } from "./scenarios.mjs";
import { schema } from "./schemas.mjs";

const [, scenario, operation, source = "lib"] = process.argv.slice(2);
const wide = scenario === "wide128";
const value = wide
  ? Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`f${i}`, i]))
  : sample(scenario, 3);
const bytes = wide
  ? Buffer.alloc(512)
  : Buffer.from(manual(scenario).encode(value));
const start = performance.now();
const api = await import(pathToFileURL(`${source}/index.js`).href);
const importMs = performance.now() - start;
const define = performance.now();
let codec;
if (wide) {
  codec = api.bin();
  for (let i = 0; i < 128; i++) codec = codec.u32le(`f${i}`);
} else {
  codec = schema(api, scenario);
}
const definitionMs = performance.now() - define;
// Mark entry into the generated function, without compiling a second decoder.
// This works with both module layouts and the one-shot buffer mode.
let entered;
const original = Function;
globalThis.Function = new Proxy(original, {
  construct(target, args) {
    const make = Reflect.construct(target, args);
    return new Proxy(make, {
      apply(factory, receiver, constants) {
        return new Proxy(Reflect.apply(factory, receiver, constants), {
          apply(fn, self, values) {
            entered ??= performance.now();
            return Reflect.apply(fn, self, values);
          },
        });
      },
    });
  },
});
const compiling = performance.now();
const result =
  operation === "encode" ? codec.encode(value) : codec.decode(bytes);
const finished = performance.now();
globalThis.Function = original;
if (entered === undefined) throw new Error("Generated function was not called");
const compileMs = entered - compiling;
const callMs = finished - entered;
if (result === undefined) throw new Error("Missing first result");
console.log(
  JSON.stringify({
    library: "binopsy",
    scenario,
    operation,
    importMs,
    definitionMs,
    compileMs,
    callMs,
    firstMs: definitionMs + compileMs + callMs,
  }),
);
