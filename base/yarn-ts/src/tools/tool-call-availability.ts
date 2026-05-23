import { restoreToolArgsToClientSchema } from "../adapters/client-tool-args.js";
import { extractToolSchemaName } from "../compat/tool-schema-pruning.js";
import { buildUserSafeErrorBashCommand } from "../path-governance/tool-call-governance.js";
import { canonicalValidationToolName } from "../tool-aliases.js";

export interface GuardrailToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export function toolDefinitionName(tool: unknown): string {
  return extractToolSchemaName(tool);
}

export function listOfferedToolNames(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function buildOfferedToolNameSet(tools: unknown[] | undefined): Set<string> {
  const offered = new Set<string>();
  if (!Array.isArray(tools) || tools.length === 0) return offered;
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (!name) continue;
    offered.add(name.toLowerCase());
    offered.add(canonicalValidationToolName(name).toLowerCase());
  }
  return offered;
}

export function findOfferedToolNameByCanonical(
  tools: unknown[] | undefined,
  canonicalToolName: string,
): string | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const wanted = canonicalToolName.trim().toLowerCase();
  if (!wanted) return null;
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (!name) continue;
    if (canonicalValidationToolName(name).toLowerCase() === wanted) {
      return name;
    }
  }
  return null;
}

export function rewriteUnavailableToolCall(
  call: GuardrailToolCall,
  offeredToolSet: Set<string>,
  offeredToolNames: string[],
  fallbackBashToolName: string | null,
): { call: GuardrailToolCall; rewritten: boolean; requestedTool?: string } {
  const requestedTool = String(call.toolName ?? "").trim();
  if (!requestedTool) return { call, rewritten: false };
  const requestedLower = requestedTool.toLowerCase();
  const requestedCanonical = canonicalValidationToolName(requestedTool).toLowerCase();
  if (offeredToolSet.has(requestedLower) || offeredToolSet.has(requestedCanonical)) {
    return { call, rewritten: false };
  }
  if (!fallbackBashToolName) {
    return { call, rewritten: false };
  }
  const preview = offeredToolNames.slice(0, 12).join(", ");
  const message = preview
    ? `Tool call blocked: requested unavailable tool "${requestedTool}". Available tools: ${preview}.`
    : `Tool call blocked: requested unavailable tool "${requestedTool}". Use only tools provided for this session.`;
  return {
    call: {
      toolCallId: call.toolCallId,
      toolName: fallbackBashToolName,
      input: {
        command: buildUserSafeErrorBashCommand(message),
        description: "Blocked unavailable tool call",
      },
    },
    rewritten: true,
    requestedTool,
  };
}

export function restoreGuardrailCallForClient(
  call: GuardrailToolCall,
  tools: unknown[] | undefined,
  clientKind: string | undefined,
): GuardrailToolCall {
  return {
    ...call,
    input: restoreToolArgsToClientSchema(
      call.toolName,
      call.input,
      tools as never,
      clientKind,
    ),
  };
}
