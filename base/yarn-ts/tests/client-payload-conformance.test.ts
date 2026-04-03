import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeMessagesRequestSchema, OpenAIChatCompletionRequestSchema } from "../src/schemas.js";
import {
  claudeMessagesToOpenAI,
  claudeToolsToSDK,
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
});

