import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { McpToolRegistry, McpToolNotFoundError, type CallerIdentity } from "./tool-registry.js";
import { createKnowledgeSearchTools } from "./handlers/knowledge-search.js";
import { createClassifyTool } from "./handlers/classify.js";
import { createPlanTool } from "./handlers/plan.js";
import { createCritiqueTool } from "./handlers/critique.js";
import { createCveLookupTool } from "./handlers/cve-lookup.js";
import { createLicenseCheckTool } from "./handlers/license-check.js";
import { createDocsLookupTool } from "./handlers/docs-lookup.js";
import { createPatchIntegrityTool } from "./handlers/patch-integrity.js";

const config = loadConfig();

const registry = new McpToolRegistry();

for (const tool of createKnowledgeSearchTools(config)) {
  registry.register(tool);
}
registry.register(createClassifyTool(config));
registry.register(createPlanTool(config));
registry.register(createCritiqueTool(config));
registry.register(createCveLookupTool());
registry.register(createLicenseCheckTool());
registry.register(createDocsLookupTool());
registry.register(createPatchIntegrityTool());

const app = Fastify({ logger: { level: config.LOG_LEVEL } });

app.get("/mcp/tools", async () => {
  return { tools: registry.getCatalog() };
});

app.post("/mcp/tools/call", async (request, reply) => {
  const body = request.body as Record<string, unknown> | null;
  const name = String(body?.name ?? "");
  const args = (body?.arguments ?? {}) as Record<string, unknown>;

  const callerRaw = body?.caller as Record<string, unknown> | undefined;
  const caller: CallerIdentity | undefined = callerRaw
    ? {
        org_id: callerRaw.org_id ? String(callerRaw.org_id) : undefined,
        tenant_ids: Array.isArray(callerRaw.tenant_ids)
          ? (callerRaw.tenant_ids as string[])
          : undefined,
        acl_groups: Array.isArray(callerRaw.acl_groups)
          ? (callerRaw.acl_groups as string[])
          : undefined,
        user_id: callerRaw.user_id ? String(callerRaw.user_id) : undefined,
      }
    : undefined;

  try {
    const result = await registry.call(name, args, caller);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    if (err instanceof McpToolNotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    const msg = err instanceof Error ? err.message : String(err);
    request.log.error({ err: msg, tool: name }, "mcp_tool_call_failed");
    return reply.code(500).send({
      error: `Tool '${name}' failed`,
      detail: msg,
    });
  }
});

app.get("/health", async () => ({
  status: "ok",
  service: "synesis-mcp-ts",
  tools: registry.size,
}));

app.get("/health/readiness", async () => ({
  status: "ready",
}));

async function main() {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    `synesis-mcp-ts listening on ${config.HOST}:${config.PORT} with ${registry.size} tools`,
  );
}

main().catch((err) => {
  console.error("MCP-TS startup failed:", err);
  process.exit(1);
});
