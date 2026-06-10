import * as z from "zod/v4";
import { TRUST_POLICY_COMPACT, renderUntrustedPromptBlock } from "@synesis/context-trust";
import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { authHeaders, bearerForUpstream } from "./deps.js";
import { LIMITS, requestFailure, sanitizeUpstreamError } from "./tool-utils.js";

const CLASSIFY_TIMEOUT_MS = 30_000;
const PLAN_TIMEOUT_MS = 120_000;
const CRITIQUE_TIMEOUT_MS = 120_000;

function plannerBase(deps: SynesisMcpDeps): string {
  return deps.plannerBaseUrl.replace(/\/$/, "");
}

function extractAssistantContent(data: Record<string, unknown>): string {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : "";
}

function safeLanguageLabel(language: string): string {
  const trimmed = language.trim();
  return /^[A-Za-z0-9_+.#-]{1,32}$/.test(trimmed) ? trimmed : "plaintext";
}

function renderCallerContextBlock(context: string, sourceId: string, contentPurpose: "code" | "context"): string {
  return renderUntrustedPromptBlock(context, {
    title: contentPurpose === "code" ? "## Code Under Review" : "## Context",
    sourceType: "user_message",
    sourceId,
    contentPurpose,
    maxChars: contentPurpose === "code" ? LIMITS.codeChars : LIMITS.contextChars,
  });
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
    if (task.length > LIMITS.queryChars) {
      return { error: "validation_error", message: `task must be ${LIMITS.queryChars} characters or fewer` };
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
      void payload;
      return sanitizeUpstreamError("classify_failed", resp.status);
    }

    return payload;
  } catch (e) {
    return requestFailure("request_failed", e);
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
    if (task.length > LIMITS.queryChars) {
      return { error: "validation_error", message: `task must be ${LIMITS.queryChars} characters or fewer` };
    }
    const context =
      args.context === undefined || args.context === null ? "" : String(args.context);
    if (context.length > LIMITS.contextChars) {
      return { error: "validation_error", message: `context must be ${LIMITS.contextChars} characters or fewer` };
    }

    const prompt = context.trim()
      ? `${task}\n\n${renderCallerContextBlock(context, "mcp:synesis_plan:context", "context")}`
      : task;

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
          messages: [
            { role: "system", content: TRUST_POLICY_COMPACT },
            { role: "user", content: prompt },
          ],
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
      void payload;
      return sanitizeUpstreamError("plan_failed", resp.status);
    }

    const data = payload as Record<string, unknown>;
    return { plan: extractAssistantContent(data) };
  } catch (e) {
    return requestFailure("request_failed", e);
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
    if (task.length > LIMITS.queryChars) {
      return { error: "validation_error", message: `task must be ${LIMITS.queryChars} characters or fewer` };
    }
    if (code.length > LIMITS.codeChars) {
      return { error: "validation_error", message: `code must be ${LIMITS.codeChars} characters or fewer` };
    }

    const languageLabel = safeLanguageLabel(language);
    const systemPrompt =
      "You are a code critic. Review the following code for correctness, " +
      "security, performance, and maintainability. Identify blocking issues " +
      "and provide actionable suggestions. Be specific and reference line " +
      `numbers where possible.\n\n${TRUST_POLICY_COMPACT}`;

    const userContent = [
      `Task:\n${task}`,
      `Language: ${languageLabel}`,
      renderCallerContextBlock(code, "mcp:synesis_critique:code", "code"),
    ].join("\n\n");

    const bearer = bearerForUpstream(auth, deps);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CRITIQUE_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBase(deps)}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Synesis-MCP-Role": "critic",
          ...authHeaders(bearer),
        },
        body: JSON.stringify({
          model: "critic",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          metadata: { synesis_model_role: "critic", synesis_tool: "synesis_critique" },
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
      void payload;
      return sanitizeUpstreamError("critique_failed", resp.status);
    }

    const data = payload as Record<string, unknown>;
    return { review: extractAssistantContent(data) };
  } catch (e) {
    return requestFailure("request_failed", e);
  }
}

export const classifyInputSchema = z.object({
  task: z.string().min(1).max(LIMITS.queryChars).describe("The task or prompt to classify"),
}).strict();

export const planInputSchema = z.object({
  task: z.string().min(1).max(LIMITS.queryChars).describe("The task to plan for"),
  context: z.string().max(LIMITS.contextChars).optional().describe("Additional context (file contents, etc.)"),
  language: z.string().max(LIMITS.shortStringChars).optional().describe("Target language"),
}).strict();

export const critiqueInputSchema = z.object({
  code: z.string().min(1).max(LIMITS.codeChars).describe("Code to review"),
  task: z.string().min(1).max(LIMITS.queryChars).describe("What the code is supposed to do"),
  language: z.string().max(LIMITS.shortStringChars).optional().describe("Programming language"),
}).strict();
