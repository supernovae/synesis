import type { AuthUser } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { SessionState } from "./session-state.js";

export function applyAuthKeyAttribution(
  state: SessionState,
  authUser: Pick<AuthUser, "authMethod" | "authKeyId" | "authKeyName" | "authKeyPrefix">,
): void {
  state.record.metadata.auth_method = authUser.authMethod;
  state.record.metadata.auth_key_id = authUser.authKeyId ?? "";
  state.record.metadata.auth_key_name = authUser.authKeyName ?? "";
  state.record.metadata.auth_key_prefix = authUser.authKeyPrefix ?? "";
}

export function createSessionContextInjector(
  config: Pick<AppConfig, "SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE">,
): (
  messages: Array<{ role: string; content: unknown }>,
  state: SessionState,
) => Array<{ role: string; content: unknown }> {
  return (messages, state) => {
    // In minimal compaction mode, skip injecting server-side architectural
    // state. Clients that manage their own context window already compact.
    if (config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE === "minimal") {
      return messages;
    }
    const compacted = state.history.find(
      (m) => m.role === "system" && m.content.includes("<ARCHITECTURAL_STATE>"),
    );
    if (!compacted) return messages;
    const alreadyPresent = messages.some(
      (m) => m.role === "system" && m.content === compacted.content,
    );
    if (alreadyPresent) return messages;
    return [{ role: "system", content: compacted.content }, ...messages];
  };
}
