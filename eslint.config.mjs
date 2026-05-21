import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  ...globals.node,
  ...globals.es2024,
  fetch: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.work/**",
      "**/coverage/**",
      "base/admin/frontend/**",
    ],
  },
  {
    files: ["base/vision-worker/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: [
      "packages/**/*.ts",
      "base/yarn-ts/**/*.ts",
      "base/planner-ts/**/*.ts",
      "base/synesis-mcp/**/*.ts",
      "base/admin-mcp-ts/**/*.ts",
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "off",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-control-regex": "warn",
      "no-extra-boolean-cast": "warn",
      "no-misleading-character-class": "warn",
      "no-regex-spaces": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-require-imports": "off",
      "preserve-caught-error": "warn",
    },
  },
  {
    files: ["**/*.test.ts", "**/tests/**/*.ts"],
    rules: {
      "no-script-url": "off",
    },
  },
);
