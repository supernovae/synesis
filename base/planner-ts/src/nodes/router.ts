import { EvidencePacketSchema, type EvidencePacket } from "../contracts/schemas.js";
import type { GraphState } from "../state/types.js";
import { validateWithRepair } from "../validation/json-repair.js";
import { NullRetrievalClient, type RetrievalClient } from "../retrieval/client.js";
import type { UnifiedResult } from "../retrieval/types.js";

export const MAX_DOCS_PER_QUERY = 5;
export const MAX_SNIPPETS_PER_PACKET = 20;
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

function parseEvidencePacket(query: string, llmOutput: string, rawResults: UnifiedResult[]): EvidencePacket {
  try {
    const parsed = validateWithRepair(llmOutput, EvidencePacketSchema);
    return {
      ...parsed,
      query: parsed.query || query,
      sources: parsed.sources.slice(0, MAX_DOCS_PER_QUERY),
      snippets: parsed.snippets.slice(0, MAX_SNIPPETS_PER_PACKET).map((snippet) => ({
        ...snippet,
        relevance: Math.max(0, Math.min(1, snippet.relevance))
      })),
      confidence: Math.max(0, Math.min(1, parsed.confidence))
    };
  } catch {
    return fallbackPacket(query, rawResults);
  }
}

function fallbackPacket(query: string, rawResults: UnifiedResult[]): EvidencePacket {
  const sources = rawResults.slice(0, MAX_DOCS_PER_QUERY).map((result) => ({
    type: (result.retrieval_source === "web" ? "web" : "doc") as "web" | "doc",
    uri: result.source_url || result.title || "unknown",
    metadata: {
      authority: result.authority ?? "",
      origin_type: result.origin_type ?? "",
      heading_path: result.heading_path ?? "",
      document_name: result.document_name ?? "",
      source_id: result.source_id ?? ""
    }
  }));
  const snippets = rawResults.slice(0, MAX_SNIPPETS_PER_PACKET).map((result) => ({
    text: result.text.slice(0, 500),
    relevance: Math.max(0, Math.min(1, result.score)),
    source_uri: result.source_url || result.title || "unknown"
  }));
  const summary = rawResults
    .slice(0, 3)
    .map((result) => result.text.slice(0, 200))
    .join("\n");
  const confidenceRaw =
    rawResults.slice(0, 3).reduce((sum, result) => sum + Math.max(0, Math.min(1, result.score)), 0) /
    Math.max(1, rawResults.slice(0, 3).length);

  return {
    query: query.slice(0, 200),
    sources,
    snippets,
    summary,
    confidence: Math.max(0, Math.min(1, confidenceRaw)),
    retrieval_notes: "Fallback: evidence assembled from raw retrieval results."
  };
}

export async function runRouter(
  state: GraphState,
  deps: { retrievalClient?: RetrievalClient; summarizerOutput?: string } = {}
): Promise<GraphState> {
  const retrievalClient = deps.retrievalClient ?? new NullRetrievalClient();
  const evidenceRequests = state.evidence_requests && state.evidence_requests.length > 0
    ? state.evidence_requests
    : [{ description: state.task_description ?? "user request" }];
  const packets: EvidencePacket[] = [];

  for (const request of evidenceRequests) {
    const query = String(request.query ?? request.description ?? state.task_description ?? "evidence request");
    const results = await retrievalClient.retrieve({ query, top_k: MAX_DOCS_PER_QUERY });
    const packet = parseEvidencePacket(query, deps.summarizerOutput ?? "{}", results);
    packets.push(packet);
  }

  const ragSourceUrls = [
    ...(state.rag_source_urls ?? []),
    ...packets.flatMap((packet) => packet.sources.map((source) => source.uri)).filter(Boolean)
  ];
  const ragDocumentNames = [
    ...(state.rag_document_names ?? []),
    ...packets
      .flatMap((packet) => packet.sources.map((source) => String(source.metadata.document_name ?? "")))
      .filter(Boolean)
  ];

  return {
    ...state,
    evidence_packets: packets,
    rag_source_urls: [...new Set(ragSourceUrls)],
    rag_document_names: [...new Set(ragDocumentNames)],
    need_more_evidence: packets.some((packet) => packet.confidence < LOW_CONFIDENCE_THRESHOLD),
    next_node: "writer"
  };
}
