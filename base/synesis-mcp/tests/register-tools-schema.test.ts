import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSynesisMcpTools } from "@synesis/mcp-tools";

type ToolCallback = (args: unknown) => unknown | Promise<unknown>;

function registeredTools() {
  const callbacks = new Map<string, ToolCallback>();
  registerSynesisMcpTools(
    {
      registerTool(name, _config, callback) {
        callbacks.set(name, callback);
      },
    },
    {
      bearerToken: "syn-test",
      userId: "user-1",
      orgId: "org-1",
      tenantIds: [],
    },
    {
      plannerBaseUrl: "http://planner.test:8080",
      internalServiceToken: "svc",
    },
    { allTools: true },
  );
  return callbacks;
}

function textPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return JSON.parse(String(content[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("registered Synesis MCP tool schemas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unknown security attributes on search calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const tool = registeredTools().get("synesis_search");
    expect(tool).toBeTypeOf("function");

    const result = await tool?.({
      query: "kubernetes deployment",
      caller_org_id: "attacker-org",
      role: "platform_admin",
    });

    expect(textPayload(result)).toMatchObject({
      error: "validation_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown patch operation attributes", async () => {
    const tool = registeredTools().get("synesis_patch_integrity");
    expect(tool).toBeTypeOf("function");

    const result = await tool?.({
      code: "print('ok')",
      patch_ops: [
        {
          op: "modify",
          path: "app.py",
          content: "print('ok')",
          run_as_admin: true,
        },
      ],
    });

    expect(textPayload(result)).toMatchObject({
      error: "validation_error",
    });
  });
});
