/**
 * ACP agent that forwards prompt turns to the Synesis Yarn HTTP API (Anthropic Messages).
 * @see https://agentclientprotocol.com/
 */
import type {
  Agent,
  AgentSideConnection,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

type YarnMessage = { role: "user" | "assistant"; content: unknown };

interface SessionData {
  messages: YarnMessage[];
  conversationId: string;
}

function envBaseUrl(): string {
  const u = (process.env.SYNESIS_YARN_URL ?? process.env.SYNESIS_CODER_URL ?? "http://127.0.0.1:8000").trim();
  return u.replace(/\/$/, "");
}

function envToken(): string {
  return (process.env.SYNESIS_YARN_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
}

function envModel(): string {
  return (process.env.SYNESIS_YARN_MODEL ?? "synesis-core").trim();
}

function blocksToUserText(blocks: ContentBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      lines.push(b.text);
    }
  }
  return lines.join("\n\n").trim();
}

export function mapAnthropicToolNameToAcpKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "execute";
  if (n.includes("read") || n.includes("file")) return "read";
  if (n.includes("write") || n.includes("edit") || n.includes("strreplace")) return "edit";
  if (n.includes("grep") || n.includes("search")) return "search";
  return "other";
}

export class SynesisYarnAcpAgent implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly sessions = new Map<string, SessionData>();

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "synesis-yarn-acp",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  async setSessionMode(): Promise<Record<string, never>> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const conversationId = `acp_${sessionId}`;
    this.sessions.set(sessionId, {
      messages: [],
      conversationId,
    });
    return { sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const token = envToken();
    if (!token) {
      throw new Error("SYNESIS_YARN_TOKEN or ANTHROPIC_AUTH_TOKEN is required for the Synesis ACP bridge");
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session ${params.sessionId}`);
    }

    const userText = blocksToUserText(params.prompt);
    if (!userText) {
      return { stopReason: "end_turn" };
    }

    session.messages.push({ role: "user", content: userText });

    const base = envBaseUrl();
    const model = envModel();

    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "x-synesis-client": "synesis-acp",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32_768,
        messages: session.messages,
        metadata: {
          synesis_conversation_id: session.conversationId,
        },
        stream: false,
      }),
      signal: this.connection.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Yarn Messages API ${res.status}: ${errText.slice(0, 500)}`);
    }

    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    };

    const content = body.content ?? [];
    const assistantBlocks: unknown[] = [];

    for (const block of content) {
      if (block.type === "text" && block.text) {
        assistantBlocks.push(block);
        await this.emitTextChunks(params.sessionId, block.text);
      } else if (block.type === "tool_use" && block.id && block.name) {
        assistantBlocks.push(block);
        const toolCallId = block.id;
        const n: SessionNotification = {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: block.name,
            kind: mapAnthropicToolNameToAcpKind(block.name),
            status: "pending",
            rawInput: block.input ?? {},
          },
        };
        await this.connection.sessionUpdate(n);
      }
    }

    if (assistantBlocks.length > 0) {
      session.messages.push({ role: "assistant", content: assistantBlocks });
    }

    return { stopReason: "end_turn" };
  }

  private async emitTextChunks(sessionId: string, text: string): Promise<void> {
    const chunkSize = 400;
    for (let i = 0; i < text.length; i += chunkSize) {
      const slice = text.slice(i, i + chunkSize);
      const n: SessionNotification = {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: slice },
        },
      };
      await this.connection.sessionUpdate(n);
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    /* Future: abort in-flight fetch tied to this session */
  }
}
