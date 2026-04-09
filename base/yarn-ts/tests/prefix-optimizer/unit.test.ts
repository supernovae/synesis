import { describe, it, expect } from "vitest";
import { classifyVolatility, splitAtVolatileBoundary, isVolatileLine } from "../../src/providers/prefix-optimizer/volatility.js";
import { parseRequest } from "../../src/providers/prefix-optimizer/request-parser.js";
import { canonicalizeTools } from "../../src/providers/prefix-optimizer/tool-canonicalizer.js";
import { extractCompactFrame } from "../../src/providers/prefix-optimizer/frame-compactor.js";
import { rebuildRequest, countSystemPrefix } from "../../src/providers/prefix-optimizer/request-rebuilder.js";
import { computeMarkerPlacements } from "../../src/providers/prefix-optimizer/marker-policy.js";
import {
  canonicalizeMessage,
  canonicalStringify,
  normalizeWhitespace,
} from "../../src/providers/prefix-optimizer/serializer.js";
import {
  buildDiagnostics,
  generateMissReport,
} from "../../src/providers/prefix-optimizer/diagnostics.js";
import type {
  ChatMessage,
  ToolDefinition,
  ParsedSegment,
} from "../../src/providers/prefix-optimizer/types.js";

/* ── Volatility Classifier ──────────────────────────────────── */

describe("volatility classifier", () => {
  it("classifies timestamps as volatile", () => {
    expect(classifyVolatility("Today's date: Tuesday Apr 8, 2026")).toBe("volatile");
    expect(classifyVolatility("2026-04-08T18:40:00Z")).toBe("volatile");
  });

  it("classifies cwd and OS info as volatile", () => {
    expect(classifyVolatility("cwd: /Users/test/project")).toBe("volatile");
    expect(classifyVolatility("OS Version: darwin 25.4.0")).toBe("volatile");
    expect(classifyVolatility("Shell: zsh")).toBe("volatile");
  });

  it("classifies open files section as volatile", () => {
    const text = "<open_and_recently_viewed_files>\nRecently viewed files:\n- src/index.ts\n</open_and_recently_viewed_files>";
    expect(classifyVolatility(text)).toBe("volatile");
  });

  it("classifies rules as stable", () => {
    const text = "<rules>\n<always_applied_workspace_rule name=\"test\">\n# Do not rewrite files\n</always_applied_workspace_rule>\n</rules>";
    expect(classifyVolatility(text)).toBe("stable");
  });

  it("classifies tool calling instructions as stable", () => {
    expect(classifyVolatility("<tool_calling>\nDon't refer to tool names\n</tool_calling>")).toBe("stable");
  });

  it("classifies WORKING_FRAME as semi-stable", () => {
    expect(classifyVolatility("<WORKING_FRAME>\ngoal=Fix auth bug\n</WORKING_FRAME>")).toBe("semi_stable");
  });

  it("classifies by category hint when provided", () => {
    expect(classifyVolatility("any text", "core_instructions")).toBe("stable");
    expect(classifyVolatility("any text", "project_guidance")).toBe("stable");
    expect(classifyVolatility("any text", "latest_user_turn")).toBe("volatile");
    expect(classifyVolatility("any text", "tool_results")).toBe("volatile");
    expect(classifyVolatility("any text", "live_context")).toBe("volatile");
    expect(classifyVolatility("any text", "task_frame")).toBe("semi_stable");
  });
});

describe("splitAtVolatileBoundary", () => {
  it("splits at first volatile line", () => {
    const text = "Stable rule 1\nStable rule 2\nToday's date: Apr 8\ncwd: /Users/test";
    const { stablePart, volatilePart } = splitAtVolatileBoundary(text);
    expect(stablePart).toBe("Stable rule 1\nStable rule 2");
    expect(volatilePart).toBe("Today's date: Apr 8\ncwd: /Users/test");
  });

  it("returns all stable when no volatile lines", () => {
    const text = "<rules>\nDo not rewrite\n</rules>";
    const { stablePart, volatilePart } = splitAtVolatileBoundary(text);
    expect(stablePart).toBe(text);
    expect(volatilePart).toBe("");
  });

  it("returns all volatile when first line is volatile", () => {
    const text = "Today's date: Apr 8\ncwd: /test";
    const { stablePart, volatilePart } = splitAtVolatileBoundary(text);
    expect(stablePart).toBe("");
    expect(volatilePart).toBe(text);
  });
});

describe("isVolatileLine", () => {
  it("detects volatile patterns", () => {
    expect(isVolatileLine("Today's date: Apr 8, 2026")).toBe(true);
    expect(isVolatileLine("cwd: /Users/me/project")).toBe(true);
    expect(isVolatileLine("OS Version: darwin 25.4.0")).toBe(true);
    expect(isVolatileLine("Do not rewrite files")).toBe(false);
  });
});

/* ── Serializer ─────────────────────────────────────────────── */

describe("serializer", () => {
  it("normalizes whitespace deterministically", () => {
    const a = normalizeWhitespace("hello  \n\n\n\nworld\r\nfoo  ");
    const b = normalizeWhitespace("hello\n\n\n\nworld\nfoo");
    expect(a).toBe(b);
  });

  it("collapses triple+ blank lines to double", () => {
    expect(normalizeWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("canonicalizes messages with deterministic key order", () => {
    const msg1: ChatMessage = { content: "hello", role: "user", name: "test" };
    const msg2: ChatMessage = { role: "user", name: "test", content: "hello" };
    expect(canonicalStringify(canonicalizeMessage(msg1))).toBe(
      canonicalStringify(canonicalizeMessage(msg2)),
    );
  });

  it("canonicalStringify sorts keys", () => {
    const a = canonicalStringify({ z: 1, a: 2, m: 3 });
    const b = canonicalStringify({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ a: 2, m: 3, z: 1 });
  });
});

/* ── Tool Canonicalizer ─────────────────────────────────────── */

describe("tool canonicalizer", () => {
  const toolA: ToolDefinition = {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  };
  const toolB: ToolDefinition = {
    type: "function",
    function: {
      name: "read_file",
      description: "Read  the contents   of a file",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  };

  it("produces identical hash for same tools in different order", () => {
    const r1 = canonicalizeTools([toolA, toolB]);
    const r2 = canonicalizeTools([toolB, toolA]);
    expect(r1.hash).toBe(r2.hash);
  });

  it("sorts tools by name", () => {
    const { tools } = canonicalizeTools([toolA, toolB]);
    expect(tools[0].function.name).toBe("read_file");
    expect(tools[1].function.name).toBe("write_file");
  });

  it("normalizes whitespace in descriptions", () => {
    const { tools } = canonicalizeTools([toolB]);
    expect(tools[0].function.description).toBe("Read the contents of a file");
  });

  it("strips dynamic content from descriptions", () => {
    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "test",
        description: "Run at /Users/john/project with session 550e8400-e29b-41d4-a716-446655440000",
        parameters: { type: "object", properties: {} },
      },
    };
    const { tools } = canonicalizeTools([tool]);
    expect(tools[0].function.description).toContain("<user>");
    expect(tools[0].function.description).toContain("<uuid>");
    expect(tools[0].function.description).not.toContain("john");
  });

  it("returns empty hash for empty tools", () => {
    expect(canonicalizeTools(undefined).hash).toBe("empty");
    expect(canonicalizeTools([]).hash).toBe("empty");
  });

  it("produces different hash when tool definition changes", () => {
    const modified: ToolDefinition = {
      ...toolA,
      function: { ...toolA.function, description: "Different description" },
    };
    const r1 = canonicalizeTools([toolA, toolB]);
    const r2 = canonicalizeTools([modified, toolB]);
    expect(r1.hash).not.toBe(r2.hash);
  });
});

/* ── Request Parser ─────────────────────────────────────────── */

describe("request parser", () => {
  const systemMsg = [
    "You are an AI coding assistant provided by Synesis.",
    "",
    "<tone_and_style>",
    "- Only use emojis if requested.",
    "</tone_and_style>",
    "",
    "<rules>",
    '<always_applied_workspace_rule name="test">',
    "# Project Conventions",
    "- Use TypeScript strict mode",
    "</always_applied_workspace_rule>",
    "</rules>",
    "",
    "<user_info>",
    "OS Version: darwin 25.4.0",
    "Shell: zsh",
    "Workspace Path: /Users/testuser/src/myproject",
    "Today's date: Tuesday Apr 8, 2026",
    "</user_info>",
    "",
    "<open_and_recently_viewed_files>",
    "Recently viewed files:",
    "- src/index.ts",
    "</open_and_recently_viewed_files>",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemMsg },
    { role: "user", content: "Fix the auth bug" },
  ];

  it("extracts core_instructions segment", () => {
    const segments = parseRequest(messages);
    const core = segments.find((s) => s.category === "core_instructions");
    expect(core).toBeDefined();
    expect(core!.stability).toBe("stable");
    expect(core!.content).toContain("AI coding assistant");
    expect(core!.content).toContain("tone_and_style");
  });

  it("extracts project_guidance segment", () => {
    const segments = parseRequest(messages);
    const proj = segments.find((s) => s.category === "project_guidance");
    expect(proj).toBeDefined();
    expect(proj!.stability).toBe("stable");
    expect(proj!.content).toContain("Project Conventions");
  });

  it("extracts live_context segment", () => {
    const segments = parseRequest(messages);
    const live = segments.find((s) => s.category === "live_context");
    expect(live).toBeDefined();
    expect(live!.stability).toBe("volatile");
    expect(live!.content).toContain("Today's date");
    expect(live!.content).toContain("Workspace Path");
  });

  it("extracts latest_user_turn segment", () => {
    const segments = parseRequest(messages);
    const user = segments.find((s) => s.category === "latest_user_turn");
    expect(user).toBeDefined();
    expect(user!.stability).toBe("volatile");
    expect(user!.content).toContain("Fix the auth bug");
  });

  it("produces consistent hashes for identical input", () => {
    const s1 = parseRequest(messages);
    const s2 = parseRequest(messages);
    for (let i = 0; i < s1.length; i++) {
      expect(s1[i].hash).toBe(s2[i].hash);
    }
  });

  it("hashes tool definitions when provided", () => {
    const tools: ToolDefinition[] = [{
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
    }];
    const segments = parseRequest(messages, tools);
    const toolSeg = segments.find((s) => s.category === "tool_definitions");
    expect(toolSeg).toBeDefined();
    expect(toolSeg!.hash).toBeTruthy();
  });
});

/* ── Frame Compactor ────────────────────────────────────────── */

describe("frame compactor", () => {
  const messagesWithFrame: ChatMessage[] = [
    {
      role: "system",
      content: "<WORKING_FRAME>\ngoal=Fix auth bug\ncurrent_phase=implementation\nactive_files=src/auth.ts,src/login.ts\npending_checks=tests\nconstraints=Must pass all tests\n</WORKING_FRAME>",
    },
    { role: "user", content: "Fix the auth bug" },
  ];

  it("extracts frame fields from WORKING_FRAME block", () => {
    const { frame } = extractCompactFrame(messagesWithFrame, null);
    expect(frame.objective).toBe("Fix auth bug");
    expect(frame.phase).toBe("implementation");
    expect(frame.filesInPlay).toContain("src/auth.ts");
    expect(frame.pendingChecks).toContain("tests");
  });

  it("returns stable hash for unchanged frame", () => {
    const r1 = extractCompactFrame(messagesWithFrame, null);
    const r2 = extractCompactFrame(messagesWithFrame, r1.hash);
    expect(r2.hash).toBe(r1.hash);
    expect(r2.changed).toBe(false);
  });

  it("detects frame changes", () => {
    const r1 = extractCompactFrame(messagesWithFrame, null);
    const modified: ChatMessage[] = [
      {
        role: "system",
        content: "<WORKING_FRAME>\ngoal=Add tests\ncurrent_phase=validation\nactive_files=src/auth.test.ts\npending_checks=lint\nconstraints=Must pass all tests\n</WORKING_FRAME>",
      },
      { role: "user", content: "Add tests" },
    ];
    const r2 = extractCompactFrame(modified, r1.hash);
    expect(r2.hash).not.toBe(r1.hash);
    expect(r2.changed).toBe(true);
  });
});

/* ── Request Rebuilder ──────────────────────────────────────── */

describe("request rebuilder", () => {
  it("places stable content before volatile content", () => {
    const segments: ParsedSegment[] = [
      { category: "core_instructions", stability: "stable", content: "You are an AI assistant.", hash: "a1", sourceIndices: [0], tokenEstimate: 10 },
      { category: "project_guidance", stability: "stable", content: "# Conventions\nUse strict mode.", hash: "b1", sourceIndices: [0], tokenEstimate: 10 },
      { category: "live_context", stability: "volatile", content: "Today's date: Apr 8", hash: "c1", sourceIndices: [0], tokenEstimate: 5 },
      { category: "latest_user_turn", stability: "volatile", content: "Fix the bug", hash: "d1", sourceIndices: [1], tokenEstimate: 5 },
    ];
    const original: ChatMessage[] = [
      { role: "system", content: "mixed content" },
      { role: "user", content: "Fix the bug" },
    ];

    const rebuilt = rebuildRequest(segments, original);

    expect(rebuilt[0].role).toBe("system");
    expect(rebuilt[0].content).toContain("AI assistant");
    expect(rebuilt[1].role).toBe("system");
    expect((rebuilt[1].content as string)).toContain("Conventions");
    expect(rebuilt[2].role).toBe("system");
    expect((rebuilt[2].content as string)).toContain("Today's date");

    const lastMsg = rebuilt[rebuilt.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("Fix the bug");
  });

  it("counts system prefix correctly", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "system", content: "c" },
      { role: "user", content: "d" },
    ];
    expect(countSystemPrefix(msgs)).toBe(3);
  });
});

/* ── Marker Policy ──────────────────────────────────────────── */

describe("marker policy", () => {
  const segments: ParsedSegment[] = [
    { category: "core_instructions", stability: "stable", content: "x".repeat(4000), hash: "core1", sourceIndices: [0], tokenEstimate: 1200 },
    { category: "project_guidance", stability: "stable", content: "y".repeat(4000), hash: "proj1", sourceIndices: [0], tokenEstimate: 1200 },
    { category: "task_frame", stability: "semi_stable", content: "z".repeat(1000), hash: "frame1", sourceIndices: [0], tokenEstimate: 300 },
    { category: "live_context", stability: "volatile", content: "volatile", hash: "v1", sourceIndices: [0], tokenEstimate: 5 },
    { category: "latest_user_turn", stability: "volatile", content: "hello", hash: "u1", sourceIndices: [4], tokenEstimate: 5 },
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: "x".repeat(4000) },
    { role: "system", content: "y".repeat(4000) },
    { role: "system", content: "z".repeat(1000) },
    { role: "system", content: "volatile" },
    { role: "user", content: "hello" },
  ];

  it("returns empty array for none backend", () => {
    expect(computeMarkerPlacements(messages, segments, null, "none")).toEqual([]);
  });

  it("places markers on stable segments for dashscope", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope");
    expect(markers).toContain(0);
    expect(markers).toContain(1);
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  it("skips task_frame marker when frame hash changed", () => {
    const prevDiag = {
      coreHash: "core1", projectHash: "proj1", toolsetHash: "", frameHash: "OLD",
      volatileHash: "", userTurnHash: "", markerBackend: "dashscope" as const,
      markerCount: 2, markerIndices: [0, 1], segmentSizes: {}, cacheMissReason: null,
      totalTokenEstimate: 2000,
    };
    const markers = computeMarkerPlacements(messages, segments, prevDiag, "dashscope");
    expect(markers).not.toContain(2);
  });

  it("places task_frame marker when frame hash unchanged", () => {
    const prevDiag = {
      coreHash: "core1", projectHash: "proj1", toolsetHash: "", frameHash: "frame1",
      volatileHash: "", userTurnHash: "", markerBackend: "dashscope" as const,
      markerCount: 2, markerIndices: [0, 1], segmentSizes: {}, cacheMissReason: null,
      totalTokenEstimate: 2000,
    };
    const markers = computeMarkerPlacements(messages, segments, prevDiag, "dashscope");
    expect(markers).toContain(2);
  });

  it("never places markers on volatile segments", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope");
    expect(markers).not.toContain(3);
    expect(markers).not.toContain(4);
  });

  it("respects max markers limit", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope", 1);
    expect(markers.length).toBeLessThanOrEqual(1);
  });
});

/* ── Diagnostics ────────────────────────────────────────────── */

describe("diagnostics", () => {
  const segments: ParsedSegment[] = [
    { category: "core_instructions", stability: "stable", content: "core", hash: "c1", sourceIndices: [0], tokenEstimate: 100 },
    { category: "project_guidance", stability: "stable", content: "proj", hash: "p1", sourceIndices: [1], tokenEstimate: 200 },
    { category: "latest_user_turn", stability: "volatile", content: "hello", hash: "u1", sourceIndices: [2], tokenEstimate: 5 },
  ];

  it("reports first_request on initial turn", () => {
    const diag = buildDiagnostics(segments, [0, 1], "dashscope", null);
    expect(diag.cacheMissReason).toBe("first_request");
  });

  it("reports null miss reason when hashes match", () => {
    const prev = buildDiagnostics(segments, [0, 1], "dashscope", null);
    const diag = buildDiagnostics(segments, [0, 1], "dashscope", prev);
    expect(diag.cacheMissReason).toBeNull();
  });

  it("detects core_instructions_changed", () => {
    const prev = buildDiagnostics(segments, [0, 1], "dashscope", null);
    const changed = segments.map((s) =>
      s.category === "core_instructions" ? { ...s, hash: "DIFFERENT" } : s,
    );
    const diag = buildDiagnostics(changed, [0, 1], "dashscope", prev);
    expect(diag.cacheMissReason).toBe("core_instructions_changed");
  });

  it("generates meaningful miss report", () => {
    const prev = buildDiagnostics(segments, [0, 1], "dashscope", null);
    const report = generateMissReport(prev, null);
    expect(report).toContain("First request");
  });

  it("reports all hashes match", () => {
    const prev = buildDiagnostics(segments, [0, 1], "dashscope", null);
    const report = generateMissReport(prev, prev);
    expect(report).toContain("cache hits expected");
  });
});
