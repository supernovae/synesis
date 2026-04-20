import { coalesceLeadingSystemMessages, ensureSystemMessagesAtBeginning } from "../tool-mapping.js";

type RoleMessage = { role: string };
type RoleContentMessage = RoleMessage & { content?: unknown };

export function normalizeSystemMessageOrdering<T extends RoleMessage>(messages: T[]): T[] {
  const ordered = ensureSystemMessagesAtBeginning(messages as never);
  return coalesceLeadingSystemMessages(ordered as never) as T[];
}

export function appendSystemMessageAndNormalize<T extends RoleContentMessage>(
  messages: T[],
  content: unknown,
): T[] {
  const appended = [...messages, { role: "system", content } as T];
  return normalizeSystemMessageOrdering(appended);
}
