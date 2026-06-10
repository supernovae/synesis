import type { FastifyBaseLogger } from "fastify";
import type { ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import { writeStatusEvent } from "./sse.js";

export type PlannerStatusPhase =
  | "intake"
  | "classifying"
  | "planning"
  | "validating"
  | "retrieving"
  | "graph_query"
  | "vector_query"
  | "web_search"
  | "reranking"
  | "tool_call"
  | "mcp_call"
  | "critic"
  | "synthesizing"
  | "streaming"
  | "complete"
  | "error";

export interface OpenWebUIStatusEvent {
  type: "status";
  data: {
    description: string;
    done: boolean;
    hidden: boolean;
    detail?: string;
    action?: string;
    [key: string]: unknown;
  };
}

export interface OpenWebUIEventContext {
  baseUrl?: string;
  token?: string;
  chatId?: string;
  messageId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PlannerStatusContext {
  logger?: Pick<FastifyBaseLogger, "debug" | "warn">;
  authzTraceId?: string;
  openWebUI?: OpenWebUIEventContext;
  legacySse?: {
    enabled: boolean;
    response: ServerResponse;
  };
}

export type PlannerStatusReporter = (
  phase: PlannerStatusPhase,
  status: "started" | "progress" | "done" | "error",
  detail?: string,
  error?: unknown,
) => void | Promise<void>;

export interface StatusEmitOptions {
  done?: boolean;
  hidden?: boolean;
  detail?: string;
  action?: string;
  legacyDetail?: string;
}

const PHASE_DESCRIPTIONS: Record<PlannerStatusPhase, string> = {
  intake: "Preparing request...",
  classifying: "Classifying task and routing workflow...",
  planning: "Building execution plan...",
  validating: "Validating plan...",
  retrieving: "Retrieving relevant context...",
  graph_query: "Querying graph context...",
  vector_query: "Querying vector database...",
  web_search: "Searching the web...",
  reranking: "Ranking retrieved evidence...",
  tool_call: "Calling external tool...",
  mcp_call: "Calling MCP tool...",
  critic: "Reviewing answer quality...",
  synthesizing: "Synthesizing response...",
  streaming: "Streaming response...",
  complete: "Done",
  error: "Workflow failed",
};

export function describeStatusPhase(phase: PlannerStatusPhase): string {
  return PHASE_DESCRIPTIONS[phase];
}

export function buildStatusEvent(description: string, options: StatusEmitOptions = {}): OpenWebUIStatusEvent {
  const data: OpenWebUIStatusEvent["data"] = {
    description,
    done: options.done ?? false,
    hidden: options.hidden ?? false,
  };
  if (options.detail) data.detail = options.detail;
  if (options.action) data.action = options.action;
  return { type: "status", data };
}

export async function emitStatus(
  ctx: PlannerStatusContext | undefined,
  description: string,
  options: StatusEmitOptions = {},
): Promise<void> {
  const event = buildStatusEvent(description, options);
  if (ctx?.legacySse?.enabled) {
    writeStatusEvent(ctx.legacySse.response, {
      description: event.data.description,
      done: event.data.done,
      detail: options.legacyDetail ?? event.data.detail,
      authz_trace_id: ctx.authzTraceId,
    });
  }
  await emitOpenWebUIEvent(ctx, event);
}

export function emitPhaseStarted(
  ctx: PlannerStatusContext | undefined,
  phase: PlannerStatusPhase,
  detail?: string,
): Promise<void> {
  return emitStatus(ctx, describeStatusPhase(phase), { detail, done: false });
}

export function emitPhaseProgress(
  ctx: PlannerStatusContext | undefined,
  phase: PlannerStatusPhase,
  detail?: string,
): Promise<void> {
  return emitStatus(ctx, describeStatusPhase(phase), { detail, done: false });
}

export function emitPhaseDone(
  ctx: PlannerStatusContext | undefined,
  phase: PlannerStatusPhase,
  detail?: string,
): Promise<void> {
  return emitStatus(ctx, phase === "complete" ? "Done" : `${describeStatusPhase(phase).replace(/\.\.\.$/, "")} done`, {
    detail,
    done: true,
  });
}

export function emitPhaseError(
  ctx: PlannerStatusContext | undefined,
  phase: PlannerStatusPhase,
  error: unknown,
): Promise<void> {
  const detail = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
  return emitStatus(ctx, describeStatusPhase("error"), {
    detail: `${describeStatusPhase(phase).replace(/\.\.\.$/, "")}: ${detail}`,
    done: true,
  });
}

export async function emitOpenWebUIEvent(
  ctx: PlannerStatusContext | undefined,
  event: OpenWebUIStatusEvent,
): Promise<boolean> {
  const owui = ctx?.openWebUI;
  if (!owui?.baseUrl || !owui.token || !owui.chatId || !owui.messageId) {
    return false;
  }

  const url = buildOpenWebUIEventUrl(owui.baseUrl, owui.chatId, owui.messageId);
  const controller = new AbortController();
  const timeoutMs = owui.timeoutMs ?? 1500;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  try {
    owui.signal?.addEventListener("abort", onAbort, { once: true });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${owui.token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!response.ok) {
      ctx?.logger?.debug?.(
        {
          status: response.status,
          chatId: owui.chatId,
          messageId: owui.messageId,
          authzTraceId: ctx.authzTraceId,
        },
        "openwebui status event post failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    ctx?.logger?.debug?.(
      {
        err: err instanceof Error ? err.message : String(err),
        chatId: owui.chatId,
        messageId: owui.messageId,
        authzTraceId: ctx?.authzTraceId,
      },
      "openwebui status event post error",
    );
    return false;
  } finally {
    clearTimeout(timer);
    owui.signal?.removeEventListener("abort", onAbort);
  }
}

export function buildOpenWebUIEventUrl(baseUrl: string, chatId: string, messageId: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/event`;
}

export function openWebUIContextFromConfig(input: {
  config: AppConfig;
  chatId?: string;
  messageId?: string;
  signal?: AbortSignal;
}): OpenWebUIEventContext | undefined {
  if (!input.config.SYNESIS_PLANNER_TS_OPENWEBUI_EVENTS_ENABLED) return undefined;
  const baseUrl = input.config.SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL.trim();
  const token = input.config.SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN.trim();
  const chatId = input.chatId?.trim();
  const messageId = input.messageId?.trim();
  if (!baseUrl || !token || !chatId || !messageId) return undefined;
  return {
    baseUrl,
    token,
    chatId,
    messageId,
    timeoutMs: input.config.SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TIMEOUT_MS,
    signal: input.signal,
  };
}
