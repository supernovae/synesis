import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SynesisYarnAcpAgent } from "../src/acp/synesis-yarn-acp-agent.js";

const TEST_BASE = "http://127.0.0.1:9";

function mockConnection(): {
  conn: AgentSideConnection;
  sessionUpdate: ReturnType<typeof vi.fn>;
} {
  const sessionUpdate = vi.fn(async () => {});
  const conn = {
    sessionUpdate,
    signal: new AbortController().signal,
    readTextFile: vi.fn(async () => ({ content: "" })),
    writeTextFile: vi.fn(async () => {}),
    createTerminal: vi.fn(),
    requestPermission: vi.fn(),
    extMethod: vi.fn(),
    extNotification: vi.fn(),
  } as unknown as AgentSideConnection;
  return { conn, sessionUpdate };
}

function agentMessageText(sessionUpdate: ReturnType<typeof vi.fn>): string {
  let out = "";
  for (const call of sessionUpdate.mock.calls as Array<
    [{ update: { sessionUpdate?: string; content?: { type?: string; text?: string } } }]
  >) {
    const u = call[0]?.update;
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && typeof u.content.text === "string") {
      out += u.content.text;
    }
  }
  return out;
}

describe("SynesisYarnAcpAgent fetch + user-visible errors", () => {
  let prevToken: string | undefined;
  let prevUrl: string | undefined;

  beforeEach(() => {
    prevToken = process.env.SYNESIS_YARN_TOKEN;
    prevUrl = process.env.SYNESIS_YARN_URL;
    process.env.SYNESIS_YARN_TOKEN = "test-token";
    process.env.SYNESIS_YARN_URL = TEST_BASE;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fallback" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevToken === undefined) delete process.env.SYNESIS_YARN_TOKEN;
    else process.env.SYNESIS_YARN_TOKEN = prevToken;
    if (prevUrl === undefined) delete process.env.SYNESIS_YARN_URL;
    else process.env.SYNESIS_YARN_URL = prevUrl;
  });

  async function setupSession(
    agent: SynesisYarnAcpAgent,
    clientCapabilities?: Parameters<SynesisYarnAcpAgent["initialize"]>[0]["clientCapabilities"],
  ): Promise<string> {
    await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities });
    const ns = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    return ns.sessionId;
  }

  it("emits user-visible error when no token (SYNESIS_YARN_TOKEN / ANTHROPIC_AUTH_TOKEN)", async () => {
    const savedAnth = process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      delete process.env.SYNESIS_YARN_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      const { conn, sessionUpdate } = mockConnection();
      const agent = new SynesisYarnAcpAgent(conn);
      await agent.initialize({ protocolVersion: PROTOCOL_VERSION });
      const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

      await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(agentMessageText(sessionUpdate)).toContain("SYNESIS_YARN_TOKEN");
    } finally {
      if (savedAnth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = savedAnth;
    }
  });

  it("emits user-visible error on fetch network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(agentMessageText(sessionUpdate)).toContain("Network error");
    expect(agentMessageText(sessionUpdate)).toContain("ECONNREFUSED");
  });

  it("parses JSON error.message on non-OK responses", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(agentMessageText(sessionUpdate)).toContain("429");
    expect(agentMessageText(sessionUpdate)).toContain("rate limited");
  });

  it("uses top-level message when error.message is absent", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "plain top" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(agentMessageText(sessionUpdate)).toContain("plain top");
  });

  it("surfaces raw body on non-OK when JSON has no message fields", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("upstream proxy failure", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(agentMessageText(sessionUpdate)).toContain("502");
    expect(agentMessageText(sessionUpdate)).toContain("upstream proxy failure");
  });

  it("emits user-visible error when body is not JSON on 200", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(agentMessageText(sessionUpdate)).toContain("non-JSON");
  });

  it("emits user-visible error when choices[0].message is missing", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(agentMessageText(sessionUpdate)).toContain("choices[0].message");
  });

  it("emits user-visible error when assistant returns no text and no tools", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: null, tool_calls: undefined } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(agentMessageText(sessionUpdate)).toContain("empty assistant message");
  });

  it("POSTs to /v1/chat/completions and streams assistant text on success", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello from coder" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${TEST_BASE}/v1/chat/completions`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
    expect(agentMessageText(sessionUpdate)).toContain("Hello from coder");
  });

  it("does not advertise ACP tools when the client provides no capabilities", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
    expect(body.tools).toBeUndefined();
  });

  it("advertises ACP tools from client capabilities", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent, {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { tools?: Array<{ function?: { name?: string; description?: string } }> };
    expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["Read", "Write", "Bash"]);
    expect(body.tools?.every((tool) => (tool.function?.description?.length ?? 0) <= 4096)).toBe(true);
  });

  it("executes returned Read tool calls through ACP fs and feeds results back to Yarn", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call_1",
                  type: "function",
                  function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" },
                }],
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "read complete" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const { conn, sessionUpdate } = mockConnection();
    vi.mocked(conn.readTextFile).mockResolvedValueOnce({ content: "file body" });
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent, { fs: { readTextFile: true } });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

    expect(conn.readTextFile).toHaveBeenCalledWith({ sessionId, path: "/tmp/README.md" });
    const second = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(second.body)) as { messages: Array<{ role: string; content?: string; tool_call_id?: string }> };
    expect(body.messages).toContainEqual({ role: "tool", tool_call_id: "call_1", name: "Read", content: "file body" });
    expect(agentMessageText(sessionUpdate)).toContain("read complete");
  });

  it("returns a structured missing-capability result when Yarn asks for an unadvertised ACP tool", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
                }],
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "handled" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const { conn } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent, { fs: { readTextFile: true } });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run pwd" }] });

    expect(conn.createTerminal).not.toHaveBeenCalled();
    const second = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(second.body)) as { messages: Array<{ role: string; content?: string }> };
    const toolResult = body.messages.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("acp_missing_client_capability");
    expect(toolResult?.content).toContain("Bash");
  });

  it("keeps cwd as shell_cwd and uses a containing additional directory as project_root", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { conn } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    await agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await agent.newSession({
      cwd: "/home/byron/k8/overseerr",
      additionalDirectories: ["/home/byron/k8"],
      mcpServers: [],
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { metadata?: Record<string, unknown> };
    expect(body.metadata?.synesis_shell_cwd).toBe("/home/byron/k8/overseerr");
    expect(body.metadata?.synesis_project_root).toBe("/home/byron/k8");
  });

  it("prefixes Model reasoning when API returns reasoning_content (OpenAI extension)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                reasoning_content: "Step A then B",
                content: "Done.",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { conn, sessionUpdate } = mockConnection();
    const agent = new SynesisYarnAcpAgent(conn);
    const sessionId = await setupSession(agent);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    const t = agentMessageText(sessionUpdate);
    expect(t).toContain("### Model reasoning");
    expect(t).toContain("Step A then B");
    expect(t).toContain("Done.");
  });
});
