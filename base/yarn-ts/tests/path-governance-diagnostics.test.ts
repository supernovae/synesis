import { describe, expect, it } from "vitest";
import {
  buildStructuredErrorBashCommand,
  buildUserSafeErrorBashCommand,
  shellEscape,
} from "../src/path-governance/diagnostics.js";

describe("path governance diagnostics", () => {
  it("shell-escapes generated diagnostic payloads", () => {
    expect(shellEscape("safe_token-1")).toBe("safe_token-1");
    expect(shellEscape("can't write here")).toBe("'can'\\''t write here'");
  });

  it("builds structured one-line stderr commands", () => {
    const command = buildStructuredErrorBashCommand({
      synesis_error: true,
      reason: "path_sandbox_violation",
      blocked_path: "/tmp/outside path",
    });

    expect(command).toContain("printf '%s\\n'");
    expect(command).toContain("path_sandbox_violation");
    expect(command).toContain(">&2; exit 2");
  });

  it("compacts user-safe diagnostic messages", () => {
    expect(buildUserSafeErrorBashCommand("  Line one\n\nLine two  ")).toBe(
      "printf '%s\\n' 'Line one Line two' >&2; exit 2",
    );
  });
});
