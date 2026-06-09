import { createHash } from "node:crypto";
import { stableJsonStringify } from "../compat/sorted-tools.js";

type Msg = { role: string; content: unknown };

export interface ForensicsSectionBreakdown {
  systemChars: number;
  userChars: number;
  assistantChars: number;
  toolChars: number;
  toolSchemaChars: number;
  toolChoiceChars: number;
  providerOptionsChars: number;
  envelopeChars: number;
  totalChars: number;
  totalBytes: number;
}

export interface RequestForensicsRecord {
  schemaVersion: "request_forensics_v1";
  providerModel: string;
  path: string;
  requestId: string;
  timestamp: number;
  stream: boolean;
  breakdown: ForensicsSectionBreakdown;
  tokenEstimate: number;
  lcpChars: number;
  lcpRatio: number;
  firstChangedIndex: number;
  firstChangedSection:
    | "system"
    | "user"
    | "assistant"
    | "tool"
    | "tool_schemas"
    | "tool_choice"
    | "provider_options"
    | "unknown";
  previousRequestId?: string;
  usage?: {
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    cacheCreationTokens: number;
    cacheHitRatio: number;
    effectiveInputTokens: number;
    tokensSavedByReduction?: number;
    effectiveInputAfterReduction?: number;
    costUsd: number;
  };
  summary: string;
  payloadPreview?: string;
  phasePolicy?: {
    enabled: boolean;
    source: "client" | "phase_policy" | "none";
    phase?: string;
    effectiveToolChoice?: string;
    filteredToolCount?: number;
    downgradedForStreaming?: boolean;
  };
  capabilityMatrix?: {
    mode: "enforced" | "shadow";
    globalOptimizationsEnabled: boolean;
    modelId: string;
    modelPath?: string;
    family?: string;
    matchedOverrideIds: string[];
    capabilityHash: string;
    architecturePolicy?: {
      profileId: string;
      policyHash: string;
      attention: string;
      activation: string;
      decoding: string;
      effectiveContextCeilingTokens?: number;
      reasons: string[];
    };
  };
}

interface BuildInput {
  providerModel: string;
  path: string;
  requestId: string;
  stream: boolean;
  messages: Msg[];
  tools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  phasePolicy?: RequestForensicsRecord["phasePolicy"];
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  previous?: { requestId: string; serialized: string };
  capturePayload: boolean;
  maxPreviewChars: number;
}

export interface RequestForensicsBuildResult {
  record: RequestForensicsRecord;
  serialized: string;
}

export function buildRequestForensics(input: BuildInput): RequestForensicsBuildResult {
  const now = Date.now();
  const normalizedPayload = {
    messages: input.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
    tools: input.tools ?? [],
    tool_choice: input.toolChoice ?? null,
    provider_options: input.providerOptions ?? {},
    stream: input.stream,
  };
  const serialized = stableJsonStringify(normalizedPayload);
  const lcpChars = input.previous ? longestCommonPrefix(serialized, input.previous.serialized) : 0;
  const lcpRatio = serialized.length > 0 ? Number((lcpChars / serialized.length).toFixed(4)) : 1;
  const firstChangedIndex = input.previous ? lcpChars : -1;
  const firstChangedSection = input.previous
    ? inferFirstChangedSection(normalizedPayload, input.previous.serialized)
    : "unknown";

  const breakdown = computeBreakdown(
    input.messages,
    input.tools,
    input.toolChoice,
    input.providerOptions,
    serialized,
  );
  const tokenEstimate = Math.ceil(breakdown.totalChars / 4);
  const summary = [
    `total=${breakdown.totalChars} chars`,
    `estimate=${tokenEstimate} tokens`,
    input.previous
      ? `lcp=${lcpChars} chars (${Math.round(lcpRatio * 100)}%)`
      : "lcp=n/a",
    input.previous
      ? `first_change=${firstChangedSection}@${firstChangedIndex}`
      : "first_change=n/a",
  ].join(" | ");

  return {
    serialized,
    record: {
      schemaVersion: "request_forensics_v1",
      providerModel: input.providerModel,
      path: input.path,
      requestId: input.requestId,
      timestamp: now,
      stream: input.stream,
      breakdown,
      tokenEstimate,
      lcpChars,
      lcpRatio,
      firstChangedIndex,
      firstChangedSection,
      previousRequestId: input.previous?.requestId,
      summary,
      phasePolicy: input.phasePolicy,
      capabilityMatrix: input.capabilityMatrix,
      payloadPreview: input.capturePayload
        ? stableJsonStringify(redactedPreviewPayload(normalizedPayload)).slice(0, Math.max(0, input.maxPreviewChars))
        : undefined,
    },
  };
}

function redactedPreviewPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    messages: summarizeMessages(payload.messages),
    tools: summarizeOpaquePayload(payload.tools),
    tool_choice: summarizeOpaquePayload(payload.tool_choice),
    provider_options: summarizeOpaquePayload(payload.provider_options),
    stream: payload.stream === true,
  };
}

function summarizeMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 200).map((message) => {
    if (!message || typeof message !== "object") {
      return summarizeScalar("unknown", message);
    }
    const row = message as Record<string, unknown>;
    const content = row.content;
    return {
      role: previewMessageRole(row.role),
      content_chars: stringSize(content),
      content_bytes: byteSize(content),
      content_hash: hashUnknown(content),
    };
  });
}

function summarizeOpaquePayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      count: value.length,
      chars: stringSize(value),
      bytes: byteSize(value),
      hash: hashUnknown(value),
    };
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return {
      kind: "object",
      key_count: keys.length,
      keys_hash: hashUnknown(keys),
      chars: stringSize(value),
      bytes: byteSize(value),
      hash: hashUnknown(value),
    };
  }
  return summarizeScalar("scalar", value);
}

function previewMessageRole(value: unknown): "system" | "user" | "assistant" | "tool" | "unknown" {
  return value === "system" || value === "user" || value === "assistant" || value === "tool"
    ? value
    : "unknown";
}

function summarizeScalar(kind: string, value: unknown): Record<string, unknown> {
  return {
    kind,
    chars: stringSize(value),
    bytes: byteSize(value),
    hash: hashUnknown(value),
  };
}

export function withUsage(
  record: RequestForensicsRecord,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number },
  reduction?: { tokensSavedByReduction?: number },
): RequestForensicsRecord {
  const savedByReduction = Math.max(0, reduction?.tokensSavedByReduction ?? 0);
  const used = {
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    tokensCached: usage.cachedTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheHitRatio: usage.inputTokens > 0 ? Number((usage.cachedTokens / usage.inputTokens).toFixed(4)) : 0,
    effectiveInputTokens: Math.max(0, usage.inputTokens - usage.cachedTokens),
    tokensSavedByReduction: savedByReduction,
    effectiveInputAfterReduction: Math.max(0, usage.inputTokens - usage.cachedTokens - savedByReduction),
    costUsd: usage.costUsd,
  };
  return {
    ...record,
    usage: used,
    summary: `${record.summary} | usage=${used.tokensIn}/${used.tokensOut}/${used.tokensCached} | cache_hit=${Math.round(
      used.cacheHitRatio * 100,
    )}% | effective_in=${used.effectiveInputTokens} | reduced_tokens=${savedByReduction} | effective_after_reduction=${used.effectiveInputAfterReduction}`,
  };
}

function computeBreakdown(
  messages: Msg[],
  tools: unknown,
  toolChoice: unknown,
  providerOptions: unknown,
  serialized: string,
): ForensicsSectionBreakdown {
  let systemChars = 0;
  let userChars = 0;
  let assistantChars = 0;
  let toolChars = 0;
  for (const m of messages) {
    const size = stringSize(m.content);
    if (m.role === "system") systemChars += size;
    else if (m.role === "user") userChars += size;
    else if (m.role === "assistant") assistantChars += size;
    else if (m.role === "tool") toolChars += size;
  }
  const toolSchemaChars = stringSize(tools);
  const toolChoiceChars = stringSize(toolChoice);
  const providerOptionsChars = stringSize(providerOptions);
  const contentChars = systemChars + userChars + assistantChars + toolChars + toolSchemaChars + toolChoiceChars + providerOptionsChars;
  const envelopeChars = Math.max(0, serialized.length - contentChars);
  return {
    systemChars,
    userChars,
    assistantChars,
    toolChars,
    toolSchemaChars,
    toolChoiceChars,
    providerOptionsChars,
    envelopeChars,
    totalChars: serialized.length,
    totalBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function inferFirstChangedSection(
  currentPayload: Record<string, unknown>,
  previousSerialized: string,
): RequestForensicsRecord["firstChangedSection"] {
  let previousPayload: Record<string, unknown>;
  try {
    previousPayload = JSON.parse(previousSerialized) as Record<string, unknown>;
  } catch {
    return "unknown";
  }
  const checks: Array<[RequestForensicsRecord["firstChangedSection"], unknown, unknown]> = [
    ["system", pickMessageChars(currentPayload.messages, "system"), pickMessageChars(previousPayload.messages, "system")],
    ["user", pickMessageChars(currentPayload.messages, "user"), pickMessageChars(previousPayload.messages, "user")],
    ["assistant", pickMessageChars(currentPayload.messages, "assistant"), pickMessageChars(previousPayload.messages, "assistant")],
    ["tool", pickMessageChars(currentPayload.messages, "tool"), pickMessageChars(previousPayload.messages, "tool")],
    ["tool_schemas", currentPayload.tools, previousPayload.tools],
    ["tool_choice", currentPayload.tool_choice, previousPayload.tool_choice],
    ["provider_options", currentPayload.provider_options, previousPayload.provider_options],
  ];
  for (const [section, a, b] of checks) {
    if (stableJsonStringify(a) !== stableJsonStringify(b)) return section;
  }
  return "unknown";
}

function pickMessageChars(messages: unknown, role: string): Array<{ role: string; chars: number }> {
  if (!Array.isArray(messages)) return [];
  const out: Array<{ role: string; chars: number }> = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    if (String(row.role ?? "") !== role) continue;
    out.push({ role, chars: stringSize(row.content) });
  }
  return out;
}

function longestCommonPrefix(a: string, b: string): number {
  const lim = Math.min(a.length, b.length);
  let idx = 0;
  while (idx < lim && a.charCodeAt(idx) === b.charCodeAt(idx)) idx++;
  return idx;
}

function stringSize(input: unknown): number {
  if (typeof input === "string") return input.length;
  if (input === null || input === undefined) return 0;
  try {
    return stableJsonStringify(input).length;
  } catch {
    return String(input).length;
  }
}

function byteSize(input: unknown): number {
  if (input === null || input === undefined) return 0;
  const text = typeof input === "string" ? input : safeStableString(input);
  return Buffer.byteLength(text, "utf8");
}

function hashUnknown(input: unknown): string {
  return createHash("sha256").update(safeStableString(input)).digest("hex").slice(0, 16);
}

function safeStableString(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    return stableJsonStringify(input);
  } catch {
    return String(input);
  }
}
