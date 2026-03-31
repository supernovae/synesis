import type { McpConfig } from "../config.js";
import type { McpToolDefinition } from "../tool-registry.js";

const PLAN_TIMEOUT_MS = 120_000;

function plannerBaseUrl(config: McpConfig): string {
  return config.SYNESIS_PLANNER_URL.replace(/\/$/, "");
}

function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token.trim()) {
    h.Authorization = `Bearer ${token.trim()}`;
  }
  return h;
}

function extractPlanContent(data: Record<string, unknown>): string {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : "";
}

export function createPlanTool(config: McpConfig): McpToolDefinition {
  return {
    name: "synesis_plan",
    description:
      "Generate an execution plan for a complex task. Returns structured steps and narrative plan text in the `plan` field.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to plan for" },
        context: { type: "string", description: "Additional context (file contents, etc.)" },
        language: { type: "string", description: "Target language", default: "python" },
      },
      required: ["task"],
    },
    handler: async (args) => {
      try {
        const task = String(args.task ?? "").trim();
        if (!task) {
          return { error: "validation_error", message: "task is required" };
        }
        const context =
          args.context === undefined || args.context === null
            ? ""
            : String(args.context);

        let prompt = task;
        if (context.trim()) {
          prompt = `${task}\n\nContext:\n${context}`;
        }

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
        let resp: Response;
        try {
          resp = await fetch(`${plannerBaseUrl(config)}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeaders(config.SYNESIS_INTERNAL_SERVICE_TOKEN),
            },
            body: JSON.stringify({
              model: "Synesis",
              messages: [{ role: "user", content: prompt }],
              stream: false,
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
            error: "plan_failed",
            status: resp.status,
            detail: payload,
          };
        }

        const data = payload as Record<string, unknown>;
        return { plan: extractPlanContent(data) };
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
