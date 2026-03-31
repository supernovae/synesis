import type { McpConfig } from "../config.js";
import type { McpToolDefinition } from "../tool-registry.js";

const CRITIQUE_TIMEOUT_MS = 120_000;

function criticCompletionsUrl(config: McpConfig): string {
  const base = config.SYNESIS_CRITIC_URL.replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function extractReviewContent(data: Record<string, unknown>): string {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : "";
}

export function createCritiqueTool(config: McpConfig): McpToolDefinition {
  return {
    name: "synesis_critique",
    description:
      "Submit code for critic review. Returns approval-oriented feedback, blocking issues, and improvement suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code to review" },
        task: { type: "string", description: "What the code is supposed to do" },
        language: { type: "string", description: "Programming language", default: "python" },
      },
      required: ["code", "task"],
    },
    handler: async (args) => {
      try {
        const code = String(args.code ?? "");
        const task = String(args.task ?? "").trim();
        const language =
          args.language === undefined || args.language === null
            ? "python"
            : String(args.language);

        if (!task) {
          return { error: "validation_error", message: "task is required" };
        }
        if (!code.trim()) {
          return { error: "validation_error", message: "code is required" };
        }

        const systemPrompt =
          "You are a code critic. Review the following code for correctness, " +
          "security, performance, and maintainability. Identify blocking issues " +
          "and provide actionable suggestions. Be specific and reference line " +
          "numbers where possible.\n\n" +
          `Task: ${task}\nLanguage: ${language}`;

        const userContent = `\`\`\`${language}\n${code}\n\`\`\``;

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), CRITIQUE_TIMEOUT_MS);
        let resp: Response;
        try {
          resp = await fetch(criticCompletionsUrl(config), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: config.SYNESIS_CRITIC_MODEL,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent },
              ],
              temperature: 0.1,
              max_tokens: 4096,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }

        let payload: unknown;
        try {
          payload = await resp.json();
        } catch {
          payload = { parse_error: true, status: resp.status };
        }

        if (!resp.ok) {
          return {
            error: "critique_failed",
            status: resp.status,
            detail: payload,
          };
        }

        const data = payload as Record<string, unknown>;
        return { review: extractReviewContent(data) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const aborted = e instanceof Error && e.name === "AbortError";
        return {
          error: aborted ? "timeout" : "request_failed",
          message,
        };
      }
    },
  };
}
