import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthResolver } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import type { ToolPrefixCache } from "../tool-prefix-cache/ToolPrefixCache.js";
import { fgaCheck } from "../openfga-client.js";
import { authRejectionLogFields } from "../routes/platform-route-support.js";
import { defaultShellAllowlistFromEnv } from "./tool-call-validator.js";
import { ToolCallInterceptor, planToSyntheticToolCalls } from "./tool-call-interceptor.js";
import type { CollapsedOperation, ParsedToolCall } from "./types.js";

function summarizeOperation(op: CollapsedOperation, idx: number): Record<string, unknown> {
  const base = { index: idx, kind: op.kind };
  if (op.kind === "passthrough") {
    return { ...base, calls: op.calls.map((c) => ({ id: c.toolCallId, name: c.toolName })) };
  }
  if (op.kind === "batch_read") {
    return { ...base, paths: op.paths, merged_duplicate_path: op.paths.some((p) => (op.pathToAllIds.get(p)?.length ?? 0) > 1) };
  }
  if (op.kind === "batch_search") {
    return { ...base, queries: op.items.map((i) => i.query) };
  }
  if (op.kind === "repo_context") {
    return { ...base, search: op.search, reads: op.reads };
  }
  if (op.kind === "merge_patch") {
    return { ...base, files: op.files.map((f) => ({ path: f.path })) };
  }
  if (op.kind === "run_tests") {
    return { ...base, command: op.command };
  }
  return base;
}

const ToolCallItemSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});

const CollapseRequestSchema = z.object({
  tool_calls: z.array(ToolCallItemSchema).min(1),
  workspace_root: z.string().nullable().optional(),
  strict_validation: z.boolean().optional().default(true),
  execute: z.boolean().optional().default(false),
});

export interface ToolCollapseRouteOptions {
  authResolver: AuthResolver;
  config: AppConfig;
  dedupeLayer?: DedupeLayer | null;
  toolPrefixCache?: ToolPrefixCache | null;
}

function parseOpenAiStyleCalls(raw: unknown): ParsedToolCall[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ParsedToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : typeof o.toolCallId === "string" ? o.toolCallId : "";
    let name = "";
    let args: unknown = {};
    if (o.function && typeof o.function === "object") {
      const fn = o.function as Record<string, unknown>;
      if (typeof fn.name === "string") name = fn.name;
      if (typeof fn.arguments === "string") {
        try {
          args = JSON.parse(fn.arguments) as unknown;
        } catch {
          args = { _raw_arguments: fn.arguments };
        }
      }
    }
    if (typeof o.name === "string") name = o.name;
    if (o.input !== undefined) args = o.input;
    if (id && name) out.push({ toolCallId: id, toolName: name, input: args });
  }
  return out.length > 0 ? out : null;
}

/**
 * Authenticated API for planning / optional execution of collapsed tool batches.
 */
export async function registerToolCollapseRoutes(
  app: FastifyInstance,
  opts: ToolCollapseRouteOptions,
): Promise<void> {
  if (!opts.config.SYNESIS_YARN_TOOL_COLLAPSE_ENABLED) {
    app.log.info("tool_collapse_routes_disabled");
    return;
  }

  app.post("/v1/coder/tool-collapse/plan", async (req, reply) => {
    let authUser;
    try {
      authUser = await opts.authResolver.resolve(req.headers.authorization);
    } catch (err) {
      app.log.warn(authRejectionLogFields(err, req.headers.authorization, "/v1/coder/tool-collapse/plan"), "auth_request_rejected");
      return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
    }
    try {
      opts.authResolver.requireCoderScope(authUser);
    } catch {
      return reply.code(403).send({ error: { type: "authz_error", message: "Insufficient scope" } });
    }

    const fga = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "completions");
    if (!fga.allowed) {
      return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
    }

    const body = req.body as Record<string, unknown> | null;
    let parsed = CollapseRequestSchema.safeParse(body);
    if (!parsed.success) {
      const oai = parseOpenAiStyleCalls(body?.tool_calls);
      if (oai) {
        parsed = CollapseRequestSchema.safeParse({
          tool_calls: oai,
          workspace_root: body?.workspace_root,
          strict_validation: body?.strict_validation,
          execute: body?.execute,
        });
      }
    }
    if (!parsed.success) {
      return reply.code(400).send({ error: { type: "invalid_request", message: parsed.error.message } });
    }

    const allowlist = defaultShellAllowlistFromEnv(opts.config.SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST);
    const interceptor = new ToolCallInterceptor({
      workspaceRoot: parsed.data.workspace_root ?? null,
      shellAllowlist: allowlist,
      strictValidation: parsed.data.strict_validation,
      execute: parsed.data.execute,
      executor: null,
      dedupeLayer: opts.dedupeLayer ?? null,
      toolPrefixCache: opts.toolPrefixCache ?? null,
      log: ({ msg, data }) => app.log.info({ msg, ...data }, "tool_collapse"),
    });

    const result = await interceptor.processImmediate(parsed.data.tool_calls);

    return reply.send({
      plan: {
        operations: result.plan.operations.map((op, idx) => summarizeOperation(op, idx)),
        log: result.plan.log,
      },
      validation: { ok: result.validated.ok, issues: result.validated.issues },
      synthetic_tool_calls: planToSyntheticToolCalls(result.plan),
      compact_json: result.compactJson,
      used_collapse: result.usedCollapse,
      ...(result.dedupe ? { dedupe: result.dedupe } : {}),
    });
  });
}
