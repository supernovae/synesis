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
    {
      name: "cargo_manifest_syntax",
      regex: /\b(?:failed to load manifest|failed to parse manifest|key with no value|expected `=`|Cargo\.toml:\d+:\d+)\b/i,
      scope_tags: ["cargo-manifest", "toml-syntax"],
      constraint_kind: "hard",
      queryTransform: () => "Rust Cargo.toml manifest TOML syntax",
    },
  ],
  verificationCommands: [
    { tool: "cargo-check", command: "cargo check", description: "Type-check without codegen" },
    { tool: "cargo-build", command: "cargo build", description: "Compile the current package or workspace" },
    { tool: "cargo-clippy", command: "cargo clippy -- -D warnings", description: "Lint with Clippy" },
    { tool: "cargo-test", command: "cargo test", description: "Run tests" },
    { tool: "cargo-fmt", command: "cargo fmt --check", description: "Check formatting" },
  ],
  fixRecipes: [
    {
      errorFamily: "manifest_syntax",
      template: "Fix the Cargo manifest syntax in {file}: Cargo.toml uses TOML, not Rust syntax.",
      description: "Cargo could not parse a Cargo.toml manifest.",
      steps: [
        "Inspect the exact Cargo.toml path and line from Cargo's diagnostic.",
        "Use # for TOML comments; remove Rust-style // file headers from Cargo.toml files.",
        "Ensure every key has a value with =, and dependency tables use valid TOML syntax.",
        "After the manifest edit, run one cargo check or cargo build from the workspace root.",
      ],
      constraints: "Do not repeatedly run Cargo before editing the manifest named in the diagnostic.",
    },
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
      steps: [
        "Verify Cargo.toml dependency",
        "Check feature flags",
        "Use correct crate:: or super:: path",
      ],
      constraints: "Pin dependency versions.",
    },
    {
      errorFamily: "missing_method",
      template:
        "In {file}: verify the method name, import the trait that provides it, or use fully-qualified syntax if ambiguous.",
      description: "Method does not exist on type, or trait needs importing.",
      steps: [
        "Check method name",
        "Import the required trait",
        "Use fully-qualified syntax if ambiguous",
      ],
      constraints: "Prefer importing trait over UFCS.",
    },
    {
      errorFamily: "unused_symbol",
      template: "In {file}: remove the unused item, prefix with _ if intentionally unused, or check cfg attributes.",
      description: "Variable, import, or function declared but never used.",
      steps: [
        "If Cargo suggests a scoped cargo fix command, run it once before retesting.",
        "Remove unused item",
        "Prefix with underscore if intentionally unused",
        "Check cfg attributes",
      ],
      constraints: "Use _ prefix convention.",
    },
    {
      errorFamily: "lifetime",
      template:
        "In {file}: add explicit lifetime annotations, consider owned types, or use 'static for global data where appropriate.",
      description: "Lifetime annotations missing or conflicting.",
      steps: [
        "Add explicit lifetime annotations",
        "Consider using owned types",
        "Use 'static for global data",
      ],
      constraints: "Prefer owned types when lifetime complexity is high.",
    },
    {
      errorFamily: "undeclared_name",
      template: "In {file}: add a use statement, fix the module path, or verify feature flags for the name.",
      description: "Name used that is not in scope.",
      steps: ["Add use statement", "Check module path", "Verify feature flags"],
      constraints: "Prefer use at module level.",
    },
  ],
  corpusPackId: "lang-rust",
};
