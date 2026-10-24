import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Type tests: `expectTypeOf` and `@ts-expect-error`, checked by `tsc`.
    typecheck: {
      enabled: true,
      include: ["test/types/**/*.test-d.ts"],
    },
    coverage: { include: ["src/**"] },
  },
});
