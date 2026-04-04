import * as z from "zod/v4";
import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { authHeaders, bearerForUpstream } from "./deps.js";

const CLASSIFY_TIMEOUT_MS = 30_000;
const PLAN_TIMEOUT_MS = 120_000;
const CRITIQUE_TIMEOUT_MS = 120_000;

function plannerBase(deps: SynesisMcpDeps): string {
  return deps.plannerBaseUrl.replace(/\/$/, "");
}

function criticCompletionsUrl(deps: SynesisMcpDeps): string {
  const base = deps.criticUrl.replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function extractAssistantContent(data: Record<string, unknown>): string {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : "";
}

export async function runClassify(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): Promise<unknown> {
  try {
    const task = String(args.task ?? "").trim();
    if (!task) {
      return { error: "validation_error", message: "task is required" };
    }

    const bearer = bearerForUpstream(auth, deps);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBase(deps)}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Synesis-MCP": "classify-only",
          ...authHeaders(bearer),
        },
        body: JSON.stringify({
          model: "Synesis",
          messages: [{ role: "user", content: task }],
          stream: false,
          max_tokens: 1,
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
        error: "classify_failed",
        status: resp.status,
        detail: payload,
      };
    }

    return payload;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      error: aborted ? "timeout" : "request_failed",
      message,
    };
  }
}

export async function runPlan(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): Promise<unknown> {
  try {
    const task = String(args.task ?? "").trim();
    if (!task) {
      return { error: "validation_error", message: "task is required" };
    }
    const context =
      args.context === undefined || args.context === null ? "" : String(args.context);

    let prompt = task;
    if (context.trim()) {
      prompt = `${task}\n\nContext:\n${context}`;
    }

    const bearer = bearerForUpstream(auth, deps);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBase(deps)}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(bearer),
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
    return { plan: extractAssistantContent(data) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      error: aborted ? "timeout" : "request_failed",
      message,
    };
  }
}

export async function runCritique(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): Promise<unknown> {
  try {
    const code = String(args.code ?? "");
    const task = String(args.task ?? "").trim();
    const language =
      args.language === undefined || args.language === null ? "python" : String(args.language);

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

    const bearer = bearerForUpstream(auth, deps);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CRITIQUE_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(criticCompletionsUrl(deps), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(bearer),
        },
        body: JSON.stringify({
          model: deps.criticModel,
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
    return { review: extractAssistantContent(data) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      error: aborted ? "timeout" : "request_failed",
      message,
    };
  }
}

export const classifyInputSchema = z.object({
  task: z.string().describe("The task or prompt to classify"),
});

export const planInputSchema = z.object({
  task: z.string().describe("The task to plan for"),
  context: z.string().optional().describe("Additional context (file contents, etc.)"),
  language: z.string().optional().describe("Target language"),
});

export const critiqueInputSchema = z.object({
  code: z.string().describe("Code to review"),
  task: z.string().describe("What the code is supposed to do"),
  language: z.string().optional().describe("Programming language"),
});
