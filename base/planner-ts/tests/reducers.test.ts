import { describe, expect, it } from "vitest";
import type { CritiqueItem, DecisionEntry, EvidencePacket } from "../src/contracts/schemas.js";
import {
  appendOnlyLedger,
  appendOnlyStrings,
  mergeCritiqueRegister,
  mergeEvidencePackets,
  setOnceDict
} from "../src/state/reducers.js";

describe("reducers", () => {
  it("deduplicates evidence packets by query and section_id", () => {
    const existing: EvidencePacket[] = [{ query: "q1", section_id: 1, summary: "old", confidence: 0.3, sources: [], snippets: [], retrieval_notes: "" }];
    const incoming: EvidencePacket[] = [{ query: "q1", section_id: 1, summary: "new", confidence: 0.8, sources: [], snippets: [], retrieval_notes: "" }];
    const merged = mergeEvidencePackets(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.summary).toBe("new");
  });

  it("enforces set-once dict", () => {
    const first = setOnceDict({}, { frame: "alpha" });
    const second = setOnceDict(first, { frame: "beta" });
    expect(second).toEqual({ frame: "alpha" });
  });

  it("keeps ledger append-only by decision_id", () => {
    const existing: DecisionEntry[] = [
      {
        decision_id: "d1",
        category: "architecture",
        chosen: "A",
        rejected_alternatives: [],
        rationale: "",
        decided_by: "planner",
        frozen: true
      }
    ];
    const incoming: DecisionEntry[] = [
      {
        decision_id: "d1",
        category: "architecture",
        chosen: "B",
        rejected_alternatives: [],
        rationale: "",
        decided_by: "planner",
        frozen: true
      },
      {
        decision_id: "d2",
        category: "scope",
        chosen: "C",
        rejected_alternatives: [],
        rationale: "",
        decided_by: "planner",
        frozen: false
      }
    ];
    const merged = appendOnlyLedger(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.chosen).toBe("A");
    expect(merged[1]?.decision_id).toBe("d2");
  });

  it("appends string fingerprints", () => {
    const merged = appendOnlyStrings(["a"], ["b", "c"]);
    expect(merged).toEqual(["a", "b", "c"]);
  });

  it("blocks critique status regression without new evidence", () => {
    const existing: Record<string, CritiqueItem> = {
      c1: {
        item_id: "c1",
        category: "quality",
        description: "",
        status: "resolved",
        evidence_ref: "url-1",
        reopen_count: 0
      }
    };
    const incoming: Record<string, CritiqueItem> = {
      c1: {
        item_id: "c1",
        category: "quality",
        description: "",
        status: "open",
        evidence_ref: "url-1",
        reopen_count: 0
      }
    };
    const merged = mergeCritiqueRegister(existing, incoming);
    expect(merged.c1?.status).toBe("resolved");
  });

  it("reopens critique item when evidence changes", () => {
    const existing: Record<string, CritiqueItem> = {
      c1: {
        item_id: "c1",
        category: "quality",
        description: "",
        status: "resolved",
        evidence_ref: "url-1",
        reopen_count: 0
      }
    };
    const incoming: Record<string, CritiqueItem> = {
      c1: {
        item_id: "c1",
        category: "quality",
        description: "",
        status: "open",
        evidence_ref: "url-2",
        reopen_count: 0
      }
    };
    const merged = mergeCritiqueRegister(existing, incoming);
    expect(merged.c1?.status).toBe("open");
    expect(merged.c1?.reopen_count).toBe(1);
  });
});
