import type { CritiqueItem, DecisionEntry, EvidencePacket } from "../contracts/schemas.js";

const STATUS_ORDER: Record<"open" | "resolved" | "settled", number> = {
  open: 0,
  resolved: 1,
  settled: 2
};

export function mergeEvidencePackets(existing: EvidencePacket[], incoming: EvidencePacket[]): EvidencePacket[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return [...incoming];

  const merged = new Map<string, EvidencePacket>();
  for (const packet of existing) {
    const key = `${packet.query}::${packet.section_id ?? "null"}`;
    merged.set(key, packet);
  }
  for (const packet of incoming) {
    const key = `${packet.query}::${packet.section_id ?? "null"}`;
    merged.set(key, packet);
  }
  return [...merged.values()];
}

export function setOnceDict<T extends Record<string, unknown>>(existing: T | undefined, incoming: T | undefined): T {
  if (existing && Object.keys(existing).length > 0) return existing;
  return (incoming ?? {}) as T;
}

export function appendOnlyLedger(existing: DecisionEntry[], incoming: DecisionEntry[]): DecisionEntry[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return [...incoming];

  const seen = new Set(existing.map((item) => item.decision_id).filter(Boolean));
  const out = [...existing];
  for (const item of incoming) {
    if (item.decision_id && seen.has(item.decision_id)) continue;
    out.push(item);
    if (item.decision_id) seen.add(item.decision_id);
  }
  return out;
}

export function appendOnlyStrings(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return [...incoming];
  return [...existing, ...incoming];
}

export function mergeCritiqueRegister(
  existing: Record<string, CritiqueItem>,
  incoming: Record<string, CritiqueItem>
): Record<string, CritiqueItem> {
  if (Object.keys(incoming).length === 0) return existing;
  if (Object.keys(existing).length === 0) return { ...incoming };

  const out: Record<string, CritiqueItem> = { ...existing };
  for (const [itemId, nextItem] of Object.entries(incoming)) {
    const prevItem = out[itemId];
    if (!prevItem) {
      out[itemId] = nextItem;
      continue;
    }

    const prevRank = STATUS_ORDER[prevItem.status];
    const nextRank = STATUS_ORDER[nextItem.status];
    if (nextRank >= prevRank) {
      out[itemId] = nextItem;
      continue;
    }

    const prevEvidence = (prevItem.evidence_ref ?? "").trim();
    const nextEvidence = (nextItem.evidence_ref ?? "").trim();
    if (nextEvidence && nextEvidence !== prevEvidence) {
      out[itemId] = {
        ...nextItem,
        reopen_count: (prevItem.reopen_count ?? 0) + 1
      };
    }
  }
  return out;
}
