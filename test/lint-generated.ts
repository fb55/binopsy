/**
 * Lints the code that codecs compile to, for correctness and performance:
 * runs the tests with this file as a setup file, which saves the source of
 * each compiled function, and checks those with oxlint.
 *
 *   npm run lint:generated
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare module "vitest" {
  export interface ProvidedContext {
    generated: string;
  }
}

if (import.meta.main) {
  // A directory of our own: others cannot add files to it.
  const out = mkdtempSync(join(tmpdir(), "binopsy-generated-"));
  const { startVitest } = await import("vitest/node");
  const tests = await startVitest([], {
    provide: { generated: out },
    run: true,
    setupFiles: [import.meta.filename],
    typecheck: { enabled: false },
  });
  await tests.close();
  if (readdirSync(out).length === 0) throw new Error("no functions saved");
  // The generator does not track which variables and code are used (unused
  // and unassigned ones, code after a failure, and resumable decoders that
  // never wait are left in), and arrays of known lengths are allocated at once.
  const rules = [
    "-A all -D correctness -D perf",
    "-A no-unused-vars -A no-unassigned-vars -A no-unreachable -A require-yield",
    "-A unicorn/no-new-array",
  ].join(" ");
  // An explicit configuration: oxlint would otherwise look for one, and run
  // it if it is JavaScript, in the directories above, such as the shared /tmp.
  const config = join(out, "oxlintrc.json");
  writeFileSync(config, "{}");
  const lint = spawnSync("oxlint", ["-c", config, ...rules.split(" "), out], {
    cwd: out,
    stdio: "inherit",
  });
  if (lint.status === 0) rmSync(out, { recursive: true });
  else process.exitCode = 1;
} else {
  const { inject } = await import("vitest");
  const out = inject("generated");
  // In a test worker: save the functions that codecs compile to.
  globalThis.Function = new Proxy(Function, {
    construct(target, args: string[]) {
      const source = args.at(-1) ?? "";
      if (/^return function\*? (?:de|en)code\(/mu.test(source)) {
        const hash = createHash("sha1").update(source).digest("hex");
        writeFileSync(
          join(out, `${hash.slice(0, 16)}.js`),
          `export function make(${args.slice(0, -1).join(", ")}) {\n${source}\n}\n`,
        );
      }
      return Reflect.construct(target, args);
    },
  });
}
