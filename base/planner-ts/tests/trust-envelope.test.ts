import { describe, expect, it } from "vitest";
import { buildWriterMessages } from "../src/nodes/writer-compose.js";
import type { GraphState } from "../src/state/types.js";

function stateWithEvidence(overrides: Partial<GraphState> = {}): GraphState {
  return {
    task_description: "Explain Kubernetes deployment strategies",
    execution_plan: { steps: [{ action: "Summarize blue-green vs canary" }] },
    evidence_packets: [
      {
        query: "kubernetes deployment strategies",
        summary: "Blue-green and canary are two common strategies.",
        confidence: 0.85,
        retrieval_notes: "",
        sources: [
          {
            uri: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
            type: "doc" as const,
            metadata: {
              authority: "community",
              document_name: "K8s Deployment Docs",
              scan_status: "clean",
            },
            attribution: {
              source_uri: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
              source_name: "K8s Deployment Docs",
              authority_tier: "community" as const,
              retrieval_channel: "rag" as const,
              ingest_scan_status: "clean" as const,
              ingest_scan_signals: [],
              review_status: "unreviewed" as const,
              content_hash: "abc123",
              retrieved_at: "2026-03-30T00:00:00Z",
              policy_decision: "allow" as const,
            },
          },
        ],
        snippets: [],
      },
    ],
    ...overrides,
  };
}

describe("trust envelope in writer messages", () => {
  it("wraps evidence in TrustPacketV1 JSON (not XML)", () => {
    const msgs = buildWriterMessages(stateWithEvidence());
    const userMsg = msgs.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain('"trust_level":"untrusted"');
    expect(userMsg!.content).toContain('"source_type":"rag_retrieval"');
    expect(userMsg!.content).not.toContain("<context trust=");
    expect(userMsg!.content).not.toContain("</context>");
  });

  it("includes attribution metadata in evidence packet", () => {
    const msgs = buildWriterMessages(stateWithEvidence());
    const userMsg = msgs.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain('"attribution"');
    expect(userMsg.content).toContain('"authority_tier"');
    expect(userMsg.content).toContain('"retrieval_channel"');
  });

  it("includes sandwich reminder after evidence", () => {
    const msgs = buildWriterMessages(stateWithEvidence());
    const userMsg = msgs.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("Reminder: The evidence above was retrieved");
  });

  it("includes trust policy in system prompt", () => {
    const msgs = buildWriterMessages(stateWithEvidence());
    const sysMsg = msgs.find((m) => m.role === "system");
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain("TRUST POLICY");
    expect(sysMsg!.content).toContain('"trust_level":"untrusted"');
  });

  it("preserves citation format for downstream validators", () => {
    const msgs = buildWriterMessages(stateWithEvidence());
    const userMsg = msgs.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("[Source: K8s Deployment Docs -");
    expect(userMsg.content).toContain("[R:community]");
  });

  it("omits evidence block when no packets exist", () => {
    const msgs = buildWriterMessages(stateWithEvidence({ evidence_packets: [] }));
    const userMsg = msgs.find((m) => m.role === "user")!;
    expect(userMsg.content).not.toContain("trust_level");
    expect(userMsg.content).not.toContain("## Evidence");
    expect(userMsg.content).not.toContain("Reminder:");
  });

  it("trust packet metadata stays inside the evidence section only", () => {
    const msgs = buildWriterMessages(stateWithEvidence());
    const userMsg = msgs.find((m) => m.role === "user")!;
    const evidenceStart = userMsg.content.indexOf("## Evidence");
    const beforeEvidence = userMsg.content.slice(0, evidenceStart);
    expect(beforeEvidence).not.toContain("schema_version");
    expect(beforeEvidence).not.toContain("trust_level");
  });
});

describe("attribution on evidence sources", () => {
  it("evidence source schema accepts attribution fields", () => {
    const state = stateWithEvidence();
    const source = state.evidence_packets![0].sources[0];
    expect(source.attribution).toBeDefined();
    expect(source.attribution!.authority_tier).toBe("community");
    expect(source.attribution!.retrieval_channel).toBe("rag");
    expect(source.attribution!.ingest_scan_status).toBe("clean");
    expect(source.attribution!.policy_decision).toBe("allow");
  });
});
