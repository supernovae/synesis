import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const rustPack: LanguagePackManifest = {
  id: "lang-rust",
  language: "rust",
  displayName: "Rust",
  version: "1.0.0",
  families: ["cargo"],
  toolSignals: [
    { pattern: /\bcargo\b|\brustc\b|\bclippy\b/i, family: "cargo" },
  ],
  classifiers: {
    cargo: (msg, ruleId) => classifyErrorFamily("cargo", msg, ruleId),
  },
  reducerFamilies: ["cargo", "clippy"],
  fastPathPatterns: [
    {
      name: "rust_error",
      regex: /\bE(\d{4})\b.*(?:rust|cargo|rustc)/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `Rust compiler error E${m[1]}`,
    },
    {
      name: "clippy_lint",
      regex: /\bclippy::(\w+)/,
      scope_tags: ["linter-rules"],
      constraint_kind: "guiding",
      queryTransform: (m) => `Rust Clippy lint ${m[1]}`,
    },
  ],
  verificationCommands: [
    { tool: "cargo-check", command: "cargo check", description: "Type-check without codegen" },
    { tool: "cargo-clippy", command: "cargo clippy -- -D warnings", description: "Lint with Clippy" },
    { tool: "cargo-test", command: "cargo test", description: "Run tests" },
    { tool: "cargo-fmt", command: "cargo fmt --check", description: "Check formatting" },
  ],
  fixRecipes: [
    {
      errorFamily: "type_mismatch",
      template: "Fix the type in {file} — check assignments, function returns, and generic parameters.",
      description: "Value type does not match what the context expects",
    },
    {
      errorFamily: "ownership",
      template: "Clone the value, restructure to avoid the move, or use references instead in {file}.",
      description: "A value was used after being moved",
    },
    {
      errorFamily: "borrow_error",
      template: "Restructure the code in {file} to avoid simultaneous mutable and immutable borrows.",
      description: "Borrow conflict — value already borrowed",
    },
    {
      errorFamily: "trait_bound",
      template: "Implement the required trait or add a trait bound to the generic parameter.",
      description: "A type does not implement a required trait",
    },
    {
      errorFamily: "import_error",
      template: "Check the crate name in Cargo.toml and the `use` path in {file}.",
      description: "Crate or module path cannot be resolved",
    },
  ],
  corpusPackId: "lang-rust",
};
