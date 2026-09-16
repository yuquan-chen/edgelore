// ESLint flat config for edgelore.
// Enforces the coding conventions in docs/conventions.md §4, §10, §11.
// eslint-config-prettier is loaded LAST so it disables every stylistic rule
// that would otherwise fight Prettier (single source of truth = Prettier).

import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        // Enable typed linting so type-aware rules (e.g.
        // no-floating-promises) work. Auto-detects the nearest tsconfig.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // §4 — no `any`; narrow with `unknown` + narrowing.
      "@typescript-eslint/no-explicit-any": "error",
      // §4 — every exported function/class method declares an explicit
      // return type (internal helpers may rely on inference).
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Don't swallow promises (catches missing await).
      "@typescript-eslint/no-floating-promises": "error",
      // No dead locals/params; allow args prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test files: node:test registrations return promises that are
    // intentionally not awaited at the top level (framework design), so
    // no-floating-promises false-positives here. Tests also cast past the
    // type system to exercise runtime validation — those `any`s never ship.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettier,
);
