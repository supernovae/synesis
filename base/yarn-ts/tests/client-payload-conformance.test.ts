import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeMessagesRequestSchema, OpenAIChatCompletionRequestSchema } from "../src/schemas.js";
import {
  claudeMessagesToOpenAI,
  claudeToolsToSDK,
  ensureSystemMessagesAtBeginning,
  mapToolChoice,
  openAIMessagesToModelMessages,
  openAIToolsToSDK,
  sanitizeToolCalls,
} from "../src/tool-mapping.js";
import { ClientAdapterPacks } from "../src/adapters/client-adapter-packs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "client_profiles");

function loadFixture<T = Record<string, unknown>>(profile: string, file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, profile, file), "utf-8")) as T;
}

describe("client payload conformance fixtures", () => {
  const packs = new ClientAdapterPacks();

  function assertStrictSystemFirst(messages: Array<{ role: string }>): void {
    let sawNonSystem = false;
    for (const msg of messages) {
      if (msg.role === "system") {
        expect(sawNonSystem).toBe(false);
      } else {
        sawNonSystem = true;
      }
    }
  }

  it("claude-code fixture parses and round-trips tool_use/tool_result", () => {
    const body = loadFixture("claude-code", "tool_use_payload.json");
    const parsed = ClaudeMessagesRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const profile = packs.resolve("claude-code");
    expect(profile.mode).toBe("ide");

    const sdkTools = claudeToolsToSDK(parsed.data.tools as never);
    expect(sdkTools).toBeDefined();
    expect(sdkTools?.read_file).toBeDefined();

    const openAiMessages = claudeMessagesToOpenAI(parsed.data.messages as never);
    expect(openAiMessages.some((m) => m.role === "assistant" && m.tool_calls?.length)).toBe(true);
    expect(openAiMessages.some((m) => m.role === "tool" && m.tool_call_id === "toolu_abc123")).toBe(true);
  });

  it("cursor fixture parses and maps OpenAI tools/messages", () => {
    const body = loadFixture("cursor", "openai_function_tools_payload.json");
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const profile = packs.resolve("cursor");
    expect(profile.mode).toBe("ide");

    const sdkTools = openAIToolsToSDK(parsed.data.tools as never);
    expect(sdkTools).toBeDefined();
    expect(sdkTools?.search_code).toBeDefined();

    const modelMessages = openAIMessagesToModelMessages(parsed.data.messages as never);
    expect(modelMessages.length).toBeGreaterThan(0);
    const assistant = modelMessages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
  });

  it("codex-cli fixture sanitizes malformed tool IDs and maps tool_choice", () => {
    const body = loadFixture("codex-cli", "openai_malformed_tool_payload.json");
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const profile = packs.resolve("codex-cli");
    expect(profile.mode).toBe("cli");

    const sanitized = sanitizeToolCalls((body as { messages: unknown[] }).messages as never);
    const assistant = sanitized.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0].id).toMatch(/^call_synth_/);

    const toolResult = sanitized.find((m) => m.role === "tool");
    expect(toolResult?.tool_call_id).toBe(assistant?.tool_calls?.[0].id);

    const mappedChoice = mapToolChoice(parsed.data.tool_choice);
    expect(mappedChoice).toEqual({ type: "tool", toolName: "list_dir" });
  });

  it.each([
    {
      profile: "roo-opencode",
      file: "openai_tool_history_payload.json",
      expectedMode: "ide",
      expectedToolChoice: "auto",
    },
    {
      profile: "opencode",
      file: "openai_function_choice_payload.json",
      expectedMode: "ide",
      expectedToolChoice: { type: "tool", toolName: "write_file" },
    },
  ])("client matrix accepts $profile OpenAI payload shape", ({ profile, file, expectedMode, expectedToolChoice }) => {
    const body = loadFixture(profile, file);
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const profileConfig = packs.resolve(profile);
    expect(profileConfig.mode).toBe(expectedMode);

    const mappedChoice = mapToolChoice(parsed.data.tool_choice);
    expect(mappedChoice).toEqual(expectedToolChoice as never);

    const sanitized = sanitizeToolCalls(parsed.data.messages as never);
    const assistantIdx = sanitized.findIndex((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
    if (assistantIdx >= 0) {
      expect(sanitized[assistantIdx + 1]?.role).toBe("tool");
    }
  });

  it("normalizes optimized transcripts to strict OpenAI system-first ordering", () => {
    const optimizedLikeMessages = [
      { role: "system", content: "core instructions" },
      { role: "user", content: "please implement feature x" },
      {
        role: "assistant",
        content: "running tool",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: "{\"file_path\":\"src/index.ts\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      // Prefix optimizer can append dynamic system context late in the turn.
      { role: "system", content: "<WORKING_FRAME>goal=implement feature x</WORKING_FRAME>" },
      { role: "system", content: "<SESSION_EXECUTION_CONTEXT>cwd=/repo</SESSION_EXECUTION_CONTEXT>" },
    ];

    const systemOrdered = ensureSystemMessagesAtBeginning(optimizedLikeMessages as never);
    const sanitized = sanitizeToolCalls(systemOrdered as never);

    // Conformance invariant for strict OpenAI-compatible gateways:
    // no system message may appear after any non-system message.
    assertStrictSystemFirst(sanitized);

    // Preserve valid assistant -> tool adjacency after ordering + sanitization.
    const assistantIdx = sanitized.findIndex((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "call_1");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(sanitized[assistantIdx + 1]?.role).toBe("tool");
    expect(sanitized[assistantIdx + 1]?.tool_call_id).toBe("call_1");

    // Still convertible to SDK model messages used by request dispatch.
    const modelMessages = openAIMessagesToModelMessages(sanitized as never);
    expect(modelMessages.length).toBeGreaterThan(0);
  });

  it("preserves user-authored steering when policy guidance is appended", () => {
    const userGuidance = [
      "<AGENT_MD>",
      "Prefer minimal diffs and run targeted tests before summarizing.",
      "</AGENT_MD>",
    ].join("\n");
    const policyGuidance = "<SYNESIS_GOVERNOR>Use one focused verification step.</SYNESIS_GOVERNOR>";
    const messages = [
      { role: "system", content: userGuidance },
      { role: "user", content: "Finish the remaining task." },
      { role: "system", content: policyGuidance },
    ];
    const normalized = sanitizeToolCalls(ensureSystemMessagesAtBeginning(messages as never) as never);
    const systemMessages = normalized.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0]?.content).toBe(userGuidance);
    expect(systemMessages[1]?.content).toBe(policyGuidance);
    const modelMessages = openAIMessagesToModelMessages(normalized as never);
    const renderedUserGuidance = modelMessages.find((m) => m.role === "system");
    expect(renderedUserGuidance).toBeDefined();
    if (renderedUserGuidance) {
      expect(String(renderedUserGuidance.content)).toContain("Prefer minimal diffs");
    }
  });
});

