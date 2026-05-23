export interface ServerSideToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ServerSideToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string };
}

export type AssistantReplayPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

export interface ServerSideToolReplayResolvers {
  artifactToolName: string;
  knowledgeToolName: string;
  devDocsToolName: string;
  webSearchToolName: string;
  webSearchToolAlias: string;
  retrieveArtifact: (input: Record<string, unknown>) => Promise<string>;
  resolveKnowledge: (input: Record<string, unknown>) => Promise<unknown>;
  resolveDevDocs: (input: Record<string, unknown>) => Promise<unknown>;
  resolveWebSearch: (input: Record<string, unknown>) => Promise<unknown>;
}

export function serverSideToolNameSet(resolvers: Pick<
  ServerSideToolReplayResolvers,
  "artifactToolName" | "knowledgeToolName" | "devDocsToolName" | "webSearchToolName" | "webSearchToolAlias"
>): Set<string> {
  return new Set([
    resolvers.artifactToolName,
    resolvers.knowledgeToolName,
    resolvers.devDocsToolName,
    resolvers.webSearchToolName,
    resolvers.webSearchToolAlias,
  ]);
}

export function splitServerSideToolCalls(
  calls: ServerSideToolCall[],
  serverToolNames: ReadonlySet<string>,
): { serverCalls: ServerSideToolCall[]; clientCalls: ServerSideToolCall[] } {
  const serverCalls = calls.filter((tc) => serverToolNames.has(tc.toolName));
  const clientCalls = calls.filter((tc) => !serverToolNames.has(tc.toolName));
  return { serverCalls, clientCalls };
}

export async function resolveServerSideToolResults(
  calls: ServerSideToolCall[],
  resolvers: ServerSideToolReplayResolvers,
): Promise<ServerSideToolResult[]> {
  const results: ServerSideToolResult[] = [];
  for (const call of calls) {
    const input = recordInput(call.input);
    if (call.toolName === resolvers.artifactToolName) {
      results.push(toolResult(call, resolvers.artifactToolName, await resolvers.retrieveArtifact(input)));
    } else if (call.toolName === resolvers.knowledgeToolName) {
      results.push(toolResult(call, resolvers.knowledgeToolName, JSON.stringify(await resolvers.resolveKnowledge(input))));
    } else if (call.toolName === resolvers.devDocsToolName) {
      results.push(toolResult(call, resolvers.devDocsToolName, JSON.stringify(await resolvers.resolveDevDocs(input))));
    } else if (call.toolName === resolvers.webSearchToolName || call.toolName === resolvers.webSearchToolAlias) {
      results.push(toolResult(call, resolvers.webSearchToolName, JSON.stringify(await resolvers.resolveWebSearch(input))));
    }
  }
  return results;
}

export function buildAssistantReplayParts(text: string | undefined, calls: ServerSideToolCall[]): AssistantReplayPart[] {
  const parts: AssistantReplayPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const call of calls) {
    parts.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

function toolResult(call: ServerSideToolCall, toolName: string, value: string): ServerSideToolResult {
  return {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName,
    output: { type: "text", value },
  };
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}
