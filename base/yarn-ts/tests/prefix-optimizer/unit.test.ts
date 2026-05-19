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
import {
  extractClientMetadata,
  extractMetadataFromMessages,
} from "../../src/providers/prefix-optimizer/metadata-extractor.js";
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

  it("classifies ChatState/FileState blocks as semi-stable", () => {
    expect(classifyVolatility("<SYNESIS_CHAT_STATE>\nactive_objective=Fix auth\n</SYNESIS_CHAT_STATE>")).toBe("semi_stable");
    expect(classifyVolatility("<SYNESIS_FILE_STATE>\nfiles_total=3\n</SYNESIS_FILE_STATE>")).toBe("semi_stable");
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

  it("extracts TASK_FRAME as task_frame segment", () => {
    const withTaskFrame: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are an AI coding assistant.",
          "<TASK_FRAME>",
          "objective=Fix login flow",
          "phase=implementation",
          "files=src/auth.ts",
          "constraints=none",
          "pending_checks=none",
          "open_issues=none",
          "next_action=Edit src/auth.ts",
          "</TASK_FRAME>",
          "<user_info>",
          "Today's date: Tuesday Apr 8, 2026",
          "</user_info>",
        ].join("\n"),
      },
      { role: "user", content: "Proceed." },
    ];
    const segments = parseRequest(withTaskFrame);
    const frame = segments.find((s) => s.category === "task_frame");
    expect(frame).toBeDefined();
    expect(frame!.content).toContain("<TASK_FRAME>");
    expect(frame!.content).toContain("objective=Fix login flow");
  });

  it("extracts ChatState/FileState blocks into task_frame segment", () => {
    const withStateBlocks: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are an AI coding assistant.",
          "<SYNESIS_CHAT_STATE>",
          "active_objective=Fix login flow",
          "</SYNESIS_CHAT_STATE>",
          "<SYNESIS_FILE_STATE>",
          "files_total=2",
          "</SYNESIS_FILE_STATE>",
        ].join("\n"),
      },
      { role: "user", content: "Proceed." },
    ];
    const segments = parseRequest(withStateBlocks);
    const frame = segments.find((s) => s.category === "task_frame");
    expect(frame).toBeDefined();
    expect(frame!.content).toContain("<SYNESIS_CHAT_STATE>");
    expect(frame!.content).toContain("<SYNESIS_FILE_STATE>");
  });

  it("anchors core extraction to Synesis-marked system message", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "Custom per-turn scaffold\ncwd: /tmp/demo" },
      {
        role: "system",
        content: [
          "You are an AI coding assistant provided by Synesis.",
          "<CLIENT_ADAPTER>",
          "client=unknown",
          "</CLIENT_ADAPTER>",
        ].join("\n"),
      },
      { role: "user", content: "Proceed." },
    ];
    const segments = parseRequest(msgs);
    const core = segments.find((s) => s.category === "core_instructions");
    const live = segments.find((s) => s.category === "live_context");
    expect(core).toBeDefined();
    expect(core!.content).toContain("provided by Synesis");
    expect(core!.content).not.toContain("Custom per-turn scaffold");
    expect(live).toBeDefined();
    expect(live!.content).toContain("Custom per-turn scaffold");
  });

  it("keeps core hash stable when system message order changes", () => {
    const synesisCore = [
      "You are an AI coding assistant provided by Synesis.",
      "<SYNESIS_CODER_WORKFLOW>",
      "phase_order=explore|implement|verify",
      "</SYNESIS_CODER_WORKFLOW>",
    ].join("\n");
    const custom = "Temporary per-turn note\nToday's date: Tuesday Apr 8, 2026";

    const a: ChatMessage[] = [
      { role: "system", content: custom },
      { role: "system", content: synesisCore },
      { role: "user", content: "Do work." },
    ];
    const b: ChatMessage[] = [
      { role: "system", content: synesisCore },
      { role: "system", content: custom },
      { role: "user", content: "Do work." },
    ];

    const aCore = parseRequest(a).find((s) => s.category === "core_instructions");
    const bCore = parseRequest(b).find((s) => s.category === "core_instructions");
    expect(aCore).toBeDefined();
    expect(bCore).toBeDefined();
    expect(aCore!.hash).toBe(bCore!.hash);
  });

  it("prefers largest core-like system section when markers are absent", () => {
    const shortDynamic = [
      "Helper note",
      "<user_info>",
      "Today's date: Tuesday Apr 8, 2026",
      "</user_info>",
    ].join("\n");
    const longStable = [
      "General coding instructions.",
      "Follow repository standards.",
      "Use focused edits and run validation.",
      "Never claim success without evidence.",
      "Prefer deterministic behavior and stable prompts.",
    ].join("\n");
    const msgs: ChatMessage[] = [
      { role: "system", content: shortDynamic },
      { role: "system", content: longStable },
      { role: "user", content: "Proceed." },
    ];
    const segments = parseRequest(msgs);
    const core = segments.find((s) => s.category === "core_instructions");
    expect(core).toBeDefined();
    expect(core!.content).toContain("General coding instructions.");
    expect(core!.content).not.toContain("Helper note");
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
  it("places latest user turn before trailing volatile system context", () => {
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

    // Stable system messages first
    expect(rebuilt[0].role).toBe("system");
    expect(rebuilt[0].content).toContain("AI assistant");
    expect(rebuilt[1].role).toBe("system");
    expect((rebuilt[1].content as string)).toContain("Conventions");

    // user turn is placed before trailing volatile system context
    expect(rebuilt[rebuilt.length - 2].role).toBe("user");
    expect(rebuilt[rebuilt.length - 2].content).toContain("Fix the bug");

    const lastMsg = rebuilt[rebuilt.length - 1];
    expect(lastMsg.role).toBe("system");
    expect(lastMsg.content).toContain("Today's date");
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

  it("keeps append-only conversation before task_frame/live_context", () => {
    const segments: ParsedSegment[] = [
      { category: "core_instructions", stability: "stable", content: "core", hash: "c1", sourceIndices: [0], tokenEstimate: 10 },
      { category: "conversation_history", stability: "volatile", content: "u1\na1", hash: "h1", sourceIndices: [1, 2], tokenEstimate: 12 },
      { category: "latest_user_turn", stability: "volatile", content: "u2", hash: "u2", sourceIndices: [3], tokenEstimate: 4 },
      { category: "task_frame", stability: "semi_stable", content: "<TASK_FRAME>\nobjective=do work\n</TASK_FRAME>", hash: "f1", sourceIndices: [0], tokenEstimate: 8 },
      { category: "live_context", stability: "volatile", content: "<user_info>\nToday's date: Apr 8\n</user_info>", hash: "l1", sourceIndices: [0], tokenEstimate: 8 },
    ];
    const original: ChatMessage[] = [
      { role: "system", content: "mixed content" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];

    const rebuilt = rebuildRequest(segments, original);
    expect(rebuilt.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "system",
      "system",
    ]);
    expect(rebuilt[3].content).toContain("u2");
    expect(rebuilt[4].content).toContain("<user_info>");
    expect(rebuilt[5].content).toContain("<TASK_FRAME>");
  });
});

/* ── Marker Policy ──────────────────────────────────────────── */

describe("marker policy", () => {
  const segments: ParsedSegment[] = [
    { category: "core_instructions", stability: "stable", content: "x".repeat(4000), hash: "core1", sourceIndices: [0], tokenEstimate: 1200 },
    { category: "project_guidance", stability: "stable", content: "y".repeat(4000), hash: "proj1", sourceIndices: [0], tokenEstimate: 1200 },
    { category: "live_context", stability: "volatile", content: "volatile stuff", hash: "v1", sourceIndices: [0], tokenEstimate: 50 },
    { category: "conversation_history", stability: "volatile", content: "history...", hash: "h1", sourceIndices: [3, 4, 5, 6], tokenEstimate: 5000 },
    { category: "latest_user_turn", stability: "volatile", content: "hello", hash: "u1", sourceIndices: [10], tokenEstimate: 5 },
  ];

  // Simulates the rebuilt message array with the new layout:
  // [stable system: core] [stable system: project_guidance] [conversation interleaved]
  // [latest user turn] [live_context system] [task_frame system]
  const messages: ChatMessage[] = [
    { role: "system", content: "x".repeat(4000) },     // 0: core_instructions
    { role: "system", content: "y".repeat(4000) },     // 1: project_guidance
    { role: "user", content: "turn 1" },                // 2: conv history
    { role: "assistant", content: "response 1" },       // 3: conv history
    { role: "user", content: "turn 2" },                // 4: conv history
    { role: "assistant", content: "response 2" },       // 5: conv history
    { role: "tool", content: "result 1", tool_call_id: "c1" }, // 6: tool results
    { role: "assistant", content: "final response" },   // 7: conv/tool
    { role: "user", content: "hello" },                 // 8: latest user turn
    { role: "system", content: "volatile stuff" },      // 9: live_context
    { role: "system", content: "task frame stuff" },    // 10: task_frame (volatile)
  ];

  it("returns empty array for none backend", () => {
    expect(computeMarkerPlacements(messages, segments, null, "none")).toEqual([]);
  });

  it("places fixed marker at end of stable system prefix", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope");
    // Fixed marker at last leading system message (project_guidance at idx 1)
    expect(markers).toEqual([1]);
    // Must NOT be on conversation, task_frame, live_context, or user
    expect(markers).not.toContain(7);
    expect(markers).not.toContain(8);
    expect(markers).not.toContain(9);
    expect(markers).not.toContain(10);
  });

  it("marker is always on a system message", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope");
    expect(messages[markers[0]].role).toBe("system");
  });

  it("marker position does not change when conversation grows", () => {
    // Add more conversation messages — marker should stay at idx 1
    const longerMessages: ChatMessage[] = [
      ...messages.slice(0, 2), // system prefix (idx 0-1)
      { role: "user", content: "extra turn" },
      { role: "assistant", content: "extra response" },
      ...messages.slice(2), // rest of conversation
    ];
    const markers = computeMarkerPlacements(longerMessages, segments, null, "dashscope");
    expect(markers).toEqual([1]); // Still at idx 1
  });

  it("respects max markers limit", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope", 1);
    expect(markers.length).toBeLessThanOrEqual(1);
  });

  it("returns marker when system prefix has enough tokens", () => {
    const markers = computeMarkerPlacements(messages, segments, null, "dashscope");
    expect(markers.length).toBe(1);
  });

  it("returns empty when system prefix is too small", () => {
    const tinyMessages: ChatMessage[] = [
      { role: "system", content: "tiny" },  // well under 1024 tokens
      { role: "user", content: "hello" },
    ];
    const tinySegments: ParsedSegment[] = [
      { category: "core_instructions", stability: "stable", content: "tiny", hash: "c", sourceIndices: [0], tokenEstimate: 5 },
      { category: "latest_user_turn", stability: "volatile", content: "hello", hash: "u", sourceIndices: [1], tokenEstimate: 5 },
    ];
    const markers = computeMarkerPlacements(tinyMessages, tinySegments, null, "dashscope");
    expect(markers).toEqual([]);
  });

  it("returns empty when only user messages (no system prefix)", () => {
    const noSystem: ChatMessage[] = [
      { role: "user", content: "hello" },
    ];
    const markers = computeMarkerPlacements(noSystem, [], null, "dashscope");
    expect(markers).toEqual([]);
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

  it("treats missing core hash as core change (diagnostic alignment)", () => {
    const prev = buildDiagnostics(segments, [0, 1], "dashscope", null);
    const withoutCore = segments.filter((s) => s.category !== "core_instructions");
    const diag = buildDiagnostics(withoutCore, [0, 1], "dashscope", prev);
    expect(diag.coreHash).toBe("");
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

/* ── Client Metadata Extractor ──────────────────────────────── */

describe("metadata extractor", () => {
  const CLAUDE_CODE_USER_INFO = `<user_info>
OS Version: darwin 25.4.0

Shell: zsh

Workspace Path: /Users/bymiller/src/synesis

Is directory a git repo: Yes, at /Users/bymiller/src/synesis

Today's date: Tuesday Apr 8, 2026

Terminals folder: /Users/bymiller/.cursor/projects/Users-bymiller-src-synesis/terminals
</user_info>`;

  const OPEN_FILES_BLOCK = `<open_and_recently_viewed_files>
Recently viewed files (recent at the top, oldest at the bottom):
- /Users/bymiller/src/synesis/base/yarn-ts/src/index.ts (total lines: 8302)
- /Users/bymiller/src/synesis/base/yarn-ts/src/config.ts (total lines: 200)

Files that are currently open and visible in the user's IDE:
- /Users/bymiller/src/synesis/base/yarn-ts/tests/prefix-optimizer/unit.test.ts (total lines: 469)
- /Users/bymiller/.cursor/projects/terminals/1.txt (total lines: 136)

Note: these files may or may not be relevant to the current conversation.
</open_and_recently_viewed_files>`;

  it("extracts workspace path from <user_info>", () => {
    const meta = extractClientMetadata(CLAUDE_CODE_USER_INFO);
    expect(meta.workspacePath).toBe("/Users/bymiller/src/synesis");
    expect(meta.projectRoot).toBe("/Users/bymiller/src/synesis");
    expect(meta.shellCwd).toBe("/Users/bymiller/src/synesis");
  });

  it("extracts OS and shell info", () => {
    const meta = extractClientMetadata(CLAUDE_CODE_USER_INFO);
    expect(meta.osVersion).toBe("darwin 25.4.0");
    expect(meta.platform).toBe("darwin");
    expect(meta.shell).toBe("zsh");
  });

  it("extracts git repo info", () => {
    const meta = extractClientMetadata(CLAUDE_CODE_USER_INFO);
    expect(meta.gitIsRepo).toBe(true);
    expect(meta.gitRepoPath).toBe("/Users/bymiller/src/synesis");
  });

  it("extracts current date", () => {
    const meta = extractClientMetadata(CLAUDE_CODE_USER_INFO);
    expect(meta.currentDate).toBe("Tuesday Apr 8, 2026");
  });

  it("extracts open and recent files", () => {
    const meta = extractClientMetadata(OPEN_FILES_BLOCK);
    expect(meta.recentFiles).toEqual([
      "/Users/bymiller/src/synesis/base/yarn-ts/src/index.ts",
      "/Users/bymiller/src/synesis/base/yarn-ts/src/config.ts",
    ]);
    expect(meta.openFiles).toEqual([
      "/Users/bymiller/src/synesis/base/yarn-ts/tests/prefix-optimizer/unit.test.ts",
      "/Users/bymiller/.cursor/projects/terminals/1.txt",
    ]);
  });

  it("extracts from combined system message", () => {
    const combined = `${CLAUDE_CODE_USER_INFO}\n\n${OPEN_FILES_BLOCK}`;
    const meta = extractClientMetadata(combined);
    expect(meta.projectRoot).toBe("/Users/bymiller/src/synesis");
    expect(meta.shell).toBe("zsh");
    expect(meta.recentFiles.length).toBeGreaterThan(0);
    expect(meta.openFiles.length).toBeGreaterThan(0);
  });

  it("handles git repo: No", () => {
    const noGit = `<user_info>
OS Version: linux 6.1.0
Shell: bash
Workspace Path: /home/dev/project
Is directory a git repo: No
Today's date: Monday Apr 7, 2026
</user_info>`;
    const meta = extractClientMetadata(noGit);
    expect(meta.gitIsRepo).toBe(false);
    expect(meta.gitRepoPath).toBeNull();
    expect(meta.workspacePath).toBe("/home/dev/project");
    expect(meta.platform).toBe("linux");
  });

  it("returns empty metadata for content without user_info", () => {
    const meta = extractClientMetadata("You are a helpful coding assistant.");
    expect(meta.projectRoot).toBeNull();
    expect(meta.shell).toBeNull();
    expect(meta.openFiles).toEqual([]);
  });

  it("extracts from messages array via extractMetadataFromMessages", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "system", content: CLAUDE_CODE_USER_INFO },
      { role: "user", content: "Fix my code" },
    ];
    const meta = extractMetadataFromMessages(messages);
    expect(meta.projectRoot).toBe("/Users/bymiller/src/synesis");
    expect(meta.shell).toBe("zsh");
  });

  it("extracts from messages with content block arrays", () => {
    const messages = [
      { role: "system", content: [
        { type: "text", text: "System instructions" },
        { type: "text", text: CLAUDE_CODE_USER_INFO },
      ]},
      { role: "user", content: "Help" },
    ];
    const meta = extractMetadataFromMessages(messages);
    expect(meta.workspacePath).toBe("/Users/bymiller/src/synesis");
  });

  it("derives projectRoot from open files when no user_info", () => {
    const meta = extractClientMetadata(OPEN_FILES_BLOCK);
    expect(meta.projectRoot).not.toBeNull();
  });

  it("handles loose patterns without <user_info> tags", () => {
    const loose = `OS Version: windows 10.0.22631
Shell: powershell
Workspace Path: C:\\Users\\dev\\project
Is directory a git repo: Yes, at C:\\Users\\dev\\project
Today's date: Wednesday Apr 9, 2026`;
    const meta = extractClientMetadata(loose);
    expect(meta.osVersion).toBe("windows 10.0.22631");
    expect(meta.shell).toBe("powershell");
    expect(meta.workspacePath).toBe("C:\\Users\\dev\\project");
  });

  it("extracts opencode Working directory when it is outside <user_info>", () => {
    const combined = `<user_info>
OS Version: linux 6.8.0
Shell: bash
Workspace Path: /home/byron/k8
</user_info>
Here is some useful information about the environment you are running in:
Working directory: /home/byron/k8/overseerr
Workspace root folder: /home/byron/k8
Platform: linux
`;
    const meta = extractClientMetadata(combined);
    expect(meta.projectRoot).toBe("/home/byron/k8");
    expect(meta.shellCwd).toBe("/home/byron/k8/overseerr");
  });

  it("extracts opencode environment block with distinct cwd and workspace root", () => {
    const opencodeSys = `You are powered by the model named claude-sonnet-4-20250514. The exact model ID is anthropic/claude-sonnet-4-20250514
Here is some useful information about the environment you are running in:
 
 Working directory: /Users/dev/projects/my-app/packages/api
 Workspace root folder: /Users/dev/projects/my-app
 Is directory a git repo: yes
 Platform: darwin
 Today's date: Thu Apr 24 2026
 `;
    const meta = extractClientMetadata(opencodeSys);
    expect(meta.projectRoot).toBe("/Users/dev/projects/my-app");
    expect(meta.shellCwd).toBe("/Users/dev/projects/my-app/packages/api");
    expect(meta.platform).toBe("darwin");
    expect(meta.gitIsRepo).toBe(true);
    expect(meta.currentDate).toBe("Thu Apr 24 2026");
  });

  it("extracts opencode environment when cwd equals workspace root", () => {
    const opencodeSys = `Here is some useful information about the environment you are running in:
 
 Working directory: /home/user/repo
 Workspace root folder: /home/user/repo
 Is directory a git repo: yes
 Platform: linux
 Today's date: Thu Apr 24 2026
 `;
    const meta = extractClientMetadata(opencodeSys);
    expect(meta.projectRoot).toBe("/home/user/repo");
    expect(meta.shellCwd).toBe("/home/user/repo");
    expect(meta.platform).toBe("linux");
  });

  it("extracts opencode cwd-only when workspace root is missing", () => {
    const cwdOnly = `Working directory: /tmp/scratch
Platform: darwin`;
    const meta = extractClientMetadata(cwdOnly);
    expect(meta.shellCwd).toBe("/tmp/scratch");
    expect(meta.projectRoot).toBe("/tmp/scratch");
    expect(meta.platform).toBe("darwin");
  });

  it("opencode Platform does not clobber OS Version when both present", () => {
    const both = `OS Version: darwin 25.4.0
Platform: darwin`;
    const meta = extractClientMetadata(both);
    expect(meta.osVersion).toBe("darwin 25.4.0");
    expect(meta.platform).toBe("darwin");
  });

  it("extracts via extractMetadataFromMessages for opencode system messages", () => {
    const messages = [
      {
        role: "system",
        content: `You are powered by the model named gpt-4.1.\nHere is some useful information about the environment you are running in:\n \n Working directory: /Users/dev/app\n Workspace root folder: /Users/dev/app\n Is directory a git repo: yes\n Platform: darwin\n Today's date: Thu Apr 24 2026\n `,
      },
      { role: "user", content: "Fix the bug" },
    ];
    const meta = extractMetadataFromMessages(messages);
    expect(meta.projectRoot).toBe("/Users/dev/app");
    expect(meta.shellCwd).toBe("/Users/dev/app");
    expect(meta.platform).toBe("darwin");
  });
});
