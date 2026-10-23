import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["lib/", "test/package/"]),
  {
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: [2, "smart"],
      "no-caller": 2,
      "dot-notation": 2,
      "no-var": 2,
      "prefer-const": 2,
      "prefer-arrow-callback": [2, { allowNamedFunctions: true }],
      "arrow-body-style": [2, "as-needed"],
      "object-shorthand": 2,
      "prefer-template": 2,
      "one-var": [2, "never"],
      "prefer-destructuring": [2, { object: true }],
      "capitalized-comments": [
        2,
        "always",
        { ignorePattern: "prettier-ignore" },
      ],
      "multiline-comment-style": [2, "starred-block"],
      "spaced-comment": [2, "always", { markers: ["/"] }],
      yoda: [2, "never"],
      curly: [2, "multi-line"],
      "no-else-return": 2,
    },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        2,
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "prefer-destructuring": 0,
    },
  },
  prettier,
);
