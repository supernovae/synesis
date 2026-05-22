import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PrefixOptimizer } from "../src/providers/prefix-optimizer/index.js";
import type { ChatMessage, ToolDefinition } from "../src/providers/prefix-optimizer/types.js";
import { ClaudeMessagesRequestSchema, OpenAIChatCompletionRequestSchema } from "../src/schemas.js";
import {
  claudeMessagesToOpenAI,
  ensureSystemMessagesAtBeginning,
  sanitizeToolCalls,
} from "../src/tool-mapping.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "client_profiles");

interface GoldenPacketFixture {
  profile: string;
  file: string;
  protocol: "anthropic" | "openai";
}

interface GoldenPacket {
  messages: ChatMessage[];
  tools: ToolDefinition[] | undefined;
}

const GOLDEN_PACKET_FIXTURES: GoldenPacketFixture[] = [
  { profile: "claude-code", file: "tool_use_payload.json", protocol: "anthropic" },
  { profile: "codex-cli", file: "openai_malformed_tool_payload.json", protocol: "openai" },
  { profile: "cursor", file: "openai_function_tools_payload.json", protocol: "openai" },
  { profile: "opencode", file: "openai_function_choice_payload.json", protocol: "openai" },
  { profile: "roo-opencode", file: "openai_tool_history_payload.json", protocol: "openai" },
];

function loadFixture<T = Record<string, unknown>>(profile: string, file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, profile, file), "utf-8")) as T;
}

function claudeToolsToOpenAITools(tools: unknown[] | undefined): ToolDefinition[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const record = tool as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: String(record.name ?? "unknown_tool"),
        description: typeof record.description === "string" ? record.description : undefined,
        parameters: typeof record.input_schema === "object" && record.input_schema !== null
          ? record.input_schema as Record<string, unknown>
          : { type: "object", properties: {} },
      },
    };
  });
}

function normalizeGoldenPacket(fixture: GoldenPacketFixture): GoldenPacket {
  const body = loadFixture(fixture.profile, fixture.file);
  if (fixture.protocol === "anthropic") {
    const parsed = ClaudeMessagesRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return { messages: [], tools: undefined };
    const messages = claudeMessagesToOpenAI(parsed.data.messages as never) as ChatMessage[];
    const tools = claudeToolsToOpenAITools(parsed.data.tools as unknown[] | undefined);
    return { messages: sanitizeToolCalls(messages as never) as ChatMessage[], tools };
  }

  const parsed = OpenAIChatCompletionRequestSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return { messages: [], tools: undefined };
  const messages = sanitizeToolCalls(
    ensureSystemMessagesAtBeginning(parsed.data.messages as never) as never,
  ) as ChatMessage[];
  return { messages, tools: parsed.data.tools as ToolDefinition[] | undefined };
}

describe("golden packet cache stability", () => {
  it.each(GOLDEN_PACKET_FIXTURES)(
    "keeps append-only cache stability for $profile/$file",
    (fixture) => {
      const packet = normalizeGoldenPacket(fixture);
      const optimizer = new PrefixOptimizer({
        markerBackend: "none",
        maxMarkers: 0,
        enableReduction: true,
        enableDiagnosticLogging: false,
      });
      const session = `golden-packet-${fixture.profile}`;
      const first = optimizer.optimize(packet.messages, packet.tools, session);
      const second = optimizer.optimize(
        [
          ...packet.messages,
          {
            role: "user",
            content: "Continue with the smallest safe verification step.",
          },
        ],
        packet.tools,
        session,
      );

      expect(second.markerIndices).toEqual([]);
      expect(second.diagnostics.toolsetHash).toBe(first.diagnostics.toolsetHash);
      expect(second.diagnostics.prefixStableBytes).toBeGreaterThan(0);
      expect(second.diagnostics.cacheMissReason).not.toBe("toolset_changed");
      expect(second.diagnostics.cacheMissReason).not.toBe("core_changed");
      expect(second.diagnostics.cacheMissReason).not.toBe("project_guidance_changed");
    },
  );

  it("keeps OpenCode volatile environment metadata out of the stable core hash", () => {
    const fixture = normalizeGoldenPacket({
      profile: "opencode",
      file: "openai_function_choice_payload.json",
      protocol: "openai",
    });
    const optimizer = new PrefixOptimizer({
      markerBackend: "none",
      maxMarkers: 0,
      enableReduction: true,
      enableDiagnosticLogging: false,
    });
    const first = optimizer.optimize(fixture.messages, fixture.tools, "opencode-volatile");
    const changedEnvironment = fixture.messages.map((message) => {
      if (message.role !== "system" || typeof message.content !== "string") return message;
      return {
        ...message,
        content: message.content
          .replace("Working directory: /Users/dev/projects/my-app", "Working directory: /tmp/other")
          .replace("Today's date: Thu Apr 24 2026", "Today's date: Fri Apr 25 2026"),
      };
    });
    const second = optimizer.optimize(changedEnvironment, fixture.tools, "opencode-volatile");

    expect(second.diagnostics.coreHash).toBe(first.diagnostics.coreHash);
    expect(second.diagnostics.volatileHash).not.toBe(first.diagnostics.volatileHash);
  });
});
