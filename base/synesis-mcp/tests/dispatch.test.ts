import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchSynesisTool } from "@synesis/mcp-tools";

const deps = {
  plannerBaseUrl: "http://planner.test:8080",
  internalServiceToken: "svc",
};

const auth = {
  bearerToken: "syn-test",
  userId: "u1",
  orgId: "o1",
  tenantIds: [] as string[],
};

describe("dispatchSynesisTool (shared with Yarn)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls planner /v1/knowledge/search for synesis_search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }),
    );

    await dispatchSynesisTool("synesis_search", { query: "hello" }, auth, deps);

    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/knowledge/search");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.query).toBe("hello");
    expect(body.caller_org_id).toBe("o1");
  });

  it("rejects caller-controlled attribution fields before execution", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }),
    );

    const result = await dispatchSynesisTool(
      "synesis_search",
      {
        query: "hello",
        caller_org_id: "attacker-org",
        caller_user_id: "attacker-user",
        caller_tenant_ids: ["attacker-tenant"],
      },
      auth,
      deps,
    );

    expect(result).toMatchObject({ error: "validation_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-object tool arguments before execution", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }),
    );

    const result = await dispatchSynesisTool("synesis_search", "query=hello", auth, deps);

    expect(result).toMatchObject({
      error: "validation_error",
      issues: [{ path: "", message: "Tool arguments must be an object" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown patch operation fields before integrity execution", async () => {
    const result = await dispatchSynesisTool(
      "synesis_patch_integrity",
      {
        code: "print('ok')",
        patch_ops: [
          {
            op: "modify",
            path: "app.py",
            content: "print('ok')",
            run_as_admin: true,
          },
        ],
      },
      auth,
      deps,
    );

    expect(result).toMatchObject({ error: "validation_error" });
  });

  it("rejects unknown Terraform plan attributes before analysis", async () => {
    const result = await dispatchSynesisTool(
      "synesis_terraform_plan_analyze",
      {
        plan_json: JSON.stringify({
          resource_changes: [
            {
              address: "aws_s3_bucket.logs",
              type: "aws_s3_bucket",
              provider_name: "registry.terraform.io/hashicorp/aws",
              change: { actions: ["create"] },
              run_as_admin: true,
            },
          ],
        }),
      },
      auth,
      deps,
    );

    expect(result).toMatchObject({ error: "validation_error" });
  });

  it("rejects unknown ECMA package metadata before analysis", async () => {
    const result = await dispatchSynesisTool(
      "synesis_ecma_environment_check",
      {
        package_json: JSON.stringify({
          type: "module",
          dependencies: { lodash: "^4.17.21" },
          invented_security_role: "platform_admin",
        }),
      },
      auth,
      deps,
    );

    expect(result).toMatchObject({ error: "validation_error" });
  });

  it("calls planner /v1/web/search for synesis_web_search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }),
    );

    await dispatchSynesisTool(
      "synesis_web_search",
      { query: "latest release notes", source_surface: "yarn_chat", request_id: "req-1" },
      auth,
      deps,
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/web/search");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.query).toBe("latest release notes");
    expect(body.source_surface).toBe("yarn_chat");
    expect(body.tool_name).toBe("synesis_web_search");
    expect(body.request_id).toBe("req-1");
    expect(body.caller_org_id).toBe("o1");
  });

  it("routes critique through planner instead of a direct critic endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "review" } }] }), { status: 200 }),
    );

    const result = await dispatchSynesisTool(
      "synesis_critique",
      { task: "review", code: "const x = 1;", language: "typescript" },
      auth,
      deps,
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe("http://planner.test:8080/v1/chat/completions");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "X-Synesis-MCP-Role": "critic" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("critic");
    expect(body.metadata.synesis_model_role).toBe("critic");
    expect(result).toEqual({ review: "review" });
  });
});
