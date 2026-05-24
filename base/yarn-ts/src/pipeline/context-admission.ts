export interface ContextAdmissionMessage {
  role: string;
  content: unknown;
}

export interface MessageRoleCounts {
  systemMessageCount: number;
  userMessageCount: number;
  toolMessageCount: number;
  totalInputChars: number;
}

export interface ContextAdmissionResult {
  decision: "allow" | "warn" | "reject";
  reason?: string;
  estimatedTokens: number;
  estimatedChars: number;
}

export function countMessageRoles(messages: ContextAdmissionMessage[]): MessageRoleCounts {
  let systemMessageCount = 0;
  let userMessageCount = 0;
  let toolMessageCount = 0;
  let totalInputChars = 0;
  for (const m of messages) {
    const chars = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    totalInputChars += chars;
    if (m.role === "system") systemMessageCount++;
    else if (m.role === "user") userMessageCount++;
    else if (m.role === "tool") toolMessageCount++;
  }
  return { systemMessageCount, userMessageCount, toolMessageCount, totalInputChars };
}

export function estimateToolSchemaChars(tools: unknown[]): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    return JSON.stringify(tools).length;
  } catch {
    return 0;
  }
}

export function evaluateContextAdmission(
  messages: ContextAdmissionMessage[],
  tools: unknown[],
  mode: "advisory" | "hybrid" | "enforced",
  warnTokens: number,
  hardTokens: number,
): ContextAdmissionResult {
  const msgChars = countMessageRoles(messages).totalInputChars;
  const schemaChars = estimateToolSchemaChars(tools);
  const estimatedChars = msgChars + schemaChars;
  const estimatedTokens = Math.ceil(estimatedChars / 4);
  if (hardTokens <= 0) {
    return { decision: "allow", estimatedTokens, estimatedChars };
  }
  if (estimatedTokens > hardTokens) {
    return {
      decision: "reject",
      reason: `estimated_input_tokens_exceeded_hard_limit (${estimatedTokens} > ${hardTokens})`,
      estimatedTokens,
      estimatedChars,
    };
  }
  if (warnTokens > 0 && estimatedTokens > warnTokens) {
    if (mode === "enforced") {
      return {
        decision: "reject",
        reason: `estimated_input_tokens_exceeded_warn_limit_enforced (${estimatedTokens} > ${warnTokens})`,
        estimatedTokens,
        estimatedChars,
      };
    }
    return {
      decision: "warn",
      reason: `estimated_input_tokens_above_warn_limit (${estimatedTokens} > ${warnTokens})`,
      estimatedTokens,
      estimatedChars,
    };
  }
  return { decision: "allow", estimatedTokens, estimatedChars };
}

export function admissionErrorMessage(result: ContextAdmissionResult): string {
  const base = "Request context is too large for safe model admission.";
  const est = `Estimated input tokens: ${result.estimatedTokens.toLocaleString()}.`;
  const hint = "Reduce history length, narrow tool output, or split the task into smaller turns.";
  return `${base} ${est} ${hint}`;
}
