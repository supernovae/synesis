import { describe, expect, it } from "vitest";
import {
  collapseRepeatedLines,
  normalizeCarriageReturns,
  shapeTerminalOutput,
  stripAnsiEscapes,
} from "../src/terminal/output-shaper.js";
import { classifyTerminalOutput } from "../src/terminal/terminal-signals.js";

describe("stripAnsiEscapes", () => {
  it("removes SGR sequences", () => {
    const { text, removed } = stripAnsiEscapes("\x1b[31mred\x1b[0m plain");
    expect(text).toBe("red plain");
    expect(removed).toBeGreaterThan(0);
  });
});

describe("normalizeCarriageReturns", () => {
  it("keeps last segment after \\r within a line", () => {
    const { text, crCollapses } = normalizeCarriageReturns("a\rb\r\nc");
    expect(text).toBe("b\nc");
    expect(crCollapses).toBeGreaterThan(0);
  });
});

describe("collapseRepeatedLines", () => {
  it("collapses identical consecutive lines", () => {
    const { text, runsCollapsed } = collapseRepeatedLines("x\nx\nx\ny");
    expect(text).toContain("×3");
    expect(runsCollapsed).toBe(1);
  });
});

describe("shapeTerminalOutput", () => {
  it("completes quickly on a 1MB string", () => {
    const big = "line\n".repeat(200_000);
    const t0 = Date.now();
    const r = shapeTerminalOutput(big);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.text.length).toBeLessThanOrEqual(big.length);
  });

  it("skip returns raw slice without shaping flags", () => {
    const r = shapeTerminalOutput("a\x1b[0mb", { skip: true });
    expect(r.shapingApplied.length).toBe(0);
  });
});

describe("classifyTerminalOutput", () => {
  it("detects sudo password prompt", () => {
    const s = classifyTerminalOutput("[sudo] password for user:");
    expect(s.classification).toBe("sudo_auth");
    expect(s.hints.length).toBeGreaterThan(0);
  });

  it("flags wall-clock timeout", () => {
    const s = classifyTerminalOutput("", { killedReason: "wall_clock_timeout" });
    expect(s.classification).toBe("interactive_or_stalled");
  });
});
