import { describe, expect, it } from "vitest";
import {
  cargoSuggestedFixCommands,
  classifyCargoCommand,
  isBroadVerificationCommandText,
  isCargoVerificationCommand,
  isDependencySetupCommand,
  isStandardVerificationCommand,
} from "../src/verification/command-taxonomy.js";

describe("verification command taxonomy", () => {
  it.each([
    ["cargo check", "check"],
    ["cargo build --workspace", "build"],
    ["cargo test -p core", "test"],
    ["cargo clippy -- -D warnings", "clippy"],
    ["cargo fmt --check", "fmt"],
    ["cargo fix --lib -p task-manager-core", "fix"],
    ["cargo miri test", "miri"],
    ["cargo bench", "bench"],
    ["cargo doc --no-deps", "doc"],
  ])("classifies Cargo command %s", (command, expected) => {
    expect(classifyCargoCommand(command)).toBe(expected);
  });

  it("treats Cargo verification commands as standard verification", () => {
    expect(isCargoVerificationCommand("cargo build --workspace")).toBe(true);
    expect(isCargoVerificationCommand("cargo check --all-targets")).toBe(true);
    expect(isCargoVerificationCommand("cargo clippy -- -D warnings")).toBe(true);
    expect(isCargoVerificationCommand("cargo fmt --check")).toBe(true);
    expect(isCargoVerificationCommand("cargo fix --lib")).toBe(false);
    expect(isStandardVerificationCommand("cargo build --workspace")).toBe(true);
    expect(isStandardVerificationCommand("cargo fmt --check")).toBe(true);
  });

  it("identifies broad Cargo verification separately from scoped checks", () => {
    expect(isBroadVerificationCommandText("cargo test --workspace")).toBe(true);
    expect(isBroadVerificationCommandText("cargo build")).toBe(true);
    expect(isBroadVerificationCommandText("cargo check -p task-manager-core")).toBe(false);
  });

  it("extracts Cargo compiler suggested fix commands", () => {
    const output = "warning: `task-manager-core` generated 1 warning (run `cargo fix --lib -p task-manager-core` to apply 1 suggestion)";
    expect(cargoSuggestedFixCommands(output)).toEqual(["cargo fix --lib -p task-manager-core"]);
  });

  it("treats Cargo dependency setup as setup, not repeated verification", () => {
    expect(isDependencySetupCommand("cargo fetch")).toBe(true);
    expect(isDependencySetupCommand("cargo update")).toBe(true);
    expect(isDependencySetupCommand("cargo generate-lockfile")).toBe(true);
    expect(isDependencySetupCommand("cargo test")).toBe(false);
  });
});
