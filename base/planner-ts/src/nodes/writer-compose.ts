import type { GraphState } from "../state/types.js";
import {
  chatCompletion,
  chatCompletionStream,
  isLlmAvailable,
  ZERO_USAGE,
  type LlmUsage,
  type StreamDelta,
  type ChatMessage,
} from "../llm/client.js";
import {
  TRUST_POLICY,
  SANDWICH_REMINDER,
  authorityDatamark,
  makeUntrustedEvidence,
  serializeStableJson,
  type AttributionV1,
} from "../security/trust-prompts.js";
import { sanitizeStepAction } from "../security/step-sanitizer.js";
import { loadConfig } from "../config.js";
import {
  getOutputStyleGuidance,
  getEpistemicGuidanceBlock,
  getWriterRegulatedBlock,
  getDiscoveryPrompt,
} from "../taxonomy/taxonomy-prompt-factory.js";
import { getWorkerPersonaBlock } from "../taxonomy/vertical-prompts.js";
import { getOntologySnapshot } from "../ontology/merge-plugins.js";
import { composePlannerPrompt } from "../prompt-composer.js";
import { enforceMermaidHygiene } from "../security/mermaid-guard.js";
import { isMetadataTagsOnlyJson } from "./writer-metadata-guard.js";

/** Chunk size when replaying writer output after mermaid sanitization (streaming path). */
const WRITER_STREAM_MERMAID_CHUNK_CHARS = 256;

/** Snippet excerpts shown to the writer per evidence packet (router caps at 20). */
const WRITER_EVIDENCE_SNIPPET_CAP = 8;
const WRITER_EVIDENCE_SNIPPET_MAX_CHARS = 500;

function writerPrefersJsonMode(state: GraphState): boolean {
  const explicitType = String((state.requested_response_format ?? {}).type ?? "").toLowerCase();
  if (explicitType === "json_object") return true;
  const inferred = String((state.task_frame ?? {}).requested_format ?? "").toLowerCase();
  return inferred === "json" || inferred === "json_object" || inferred === "structured_json";
}

function deterministicJsonDraft(state: GraphState): string {
  return JSON.stringify({
    answer: deterministicDraft(state),
    grounded: false,
  });
}

function emitWriterStreamingChunks(text: string, onDelta: (delta: StreamDelta) => void): void {
  if (!text) return;
  for (let i = 0; i < text.length; i += WRITER_STREAM_MERMAID_CHUNK_CHARS) {
    onDelta({ content: text.slice(i, i + WRITER_STREAM_MERMAID_CHUNK_CHARS) });
  }
}

export interface WriterResult {
  content: string;
  usage: LlmUsage;
}

function evidenceHasWebSources(state: GraphState): boolean {
  for (const packet of state.evidence_packets ?? []) {
    for (const source of packet.sources ?? []) {
      if (source.type === "web") return true;
    }
  }
  return false;
}

/** True when evidence includes non-trivial excerpt text (RAG or web). */
function evidenceHasSubstantialSnippets(state: GraphState): boolean {
  for (const packet of state.evidence_packets ?? []) {
    for (const snippet of packet.snippets ?? []) {
      if (String(snippet.text ?? "").trim().length >= 20) return true;
    }
  }
  return false;
}

function renderEvidenceContext(state: GraphState): string {
  const packets = state.evidence_packets ?? [];
  if (packets.length === 0) return "";

  const lines: string[] = [
    `Retrieved: ${new Date().toISOString().slice(0, 16)}Z`,
  ];
  for (const packet of packets.slice(0, 3)) {
    lines.push(`Query: ${packet.query}`);
    lines.push(packet.summary || "No summary available.");
    for (const source of packet.sources.slice(0, 5)) {
      const authority = String(source.metadata.authority ?? "external");
      const sourceType = source.type === "web" ? "web" : "rag";
      const mark = authorityDatamark(authority, sourceType);
      const docName = String(source.metadata.document_name ?? source.uri);
      lines.push(`${mark} [Source: ${docName} - [${source.uri}]]`);
    }
    const snippets = packet.snippets ?? [];
    for (const snippet of snippets.slice(0, WRITER_EVIDENCE_SNIPPET_CAP)) {
      const excerpt = String(snippet.text ?? "").slice(0, WRITER_EVIDENCE_SNIPPET_MAX_CHARS).trim();
      if (!excerpt) continue;
      const uri = String(snippet.source_uri ?? "").trim() || "(unknown source)";
      lines.push(`Excerpt: [${uri}] ${excerpt}`);
    }
  }
  return lines.join("\n");
}

function buildEvidenceAttribution(state: GraphState): AttributionV1 {
  const packets = state.evidence_packets ?? [];
  const firstSource = packets[0]?.sources?.[0];
  const authority = String(firstSource?.metadata?.authority ?? "external");
  const sourceType = firstSource?.type === "web" ? "web" : "rag";
  return {
    source_uri: firstSource?.uri ?? "",
    source_name: String(firstSource?.metadata?.document_name ?? ""),
    authority_tier: (["canonical", "vetted", "community", "external", "web"].includes(authority) ? authority : "external") as AttributionV1["authority_tier"],
    retrieval_channel: sourceType === "web" ? "web" : "rag",
    ingest_scan_status: String(firstSource?.metadata?.scan_status ?? "unscanned") as AttributionV1["ingest_scan_status"],
    ingest_scan_signals: [],
    review_status: String(firstSource?.metadata?.review_status ?? "unreviewed") as AttributionV1["review_status"],
    content_hash: "",
    retrieved_at: new Date().toISOString(),
    policy_decision: "allow",
  };
}

function renderPlanContext(state: GraphState): string {
  const plan = state.execution_plan ?? {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length === 0) return "";
  return steps.map((step) => `- ${sanitizeStepAction(String(step.action ?? "Unnamed step"))}`).join("\n");
}

function deterministicDraft(state: GraphState): string {
  const prompt = state.task_description ?? "No user prompt supplied.";
  return [
    `I understand your request: ${prompt}`,
    "",
    "I was unable to generate a fully grounded response at this time.",
    "Please try again shortly, or rephrase your question for a more targeted answer."
  ].join("\n");
}

function buildAssumptionInstructions(state: GraphState): string {
  if (!state.show_assumptions) return "";

  const assumptions = state.assumptions ?? [];
  const answeredClarification = Boolean(state.user_answer_to_clarification);
  const difficulty = state.difficulty ?? 0.3;

  const rules: string[] = [
    "EPISTEMIC LABELING RULES:",
    "- When you make a material assumption that affects the answer, tag it inline with [Assumption: brief description].",
    "- When you give a numerical approximation or estimate, tag it with [Estimate: brief basis].",
    "- When citing a specific goal, SLA, or requirement, tag it with [Target: source or context].",
    "- When citing a directly measured or observed value, tag it with [Measured: source or method].",
  ];

  if (answeredClarification) {
    rules.push("- Items the user clarified should be tagged with [Clarified] to show they were confirmed.");
  }

  if (assumptions.length > 0) {
    rules.push(`\nThe planner identified these assumptions: ${assumptions.map((a) => `"${a}"`).join(", ")}. Tag them in your response where relevant.`);
  }

  if (difficulty >= 0.6) {
    rules.push("\nFor this complex topic, include a brief 'Assumptions & Caveats' section at the end summarizing key assumptions and their impact.");
  }

  return rules.join("\n");
}

const MERMAID_RULES = [
  "MERMAID OUTPUT RULES (apply only when emitting a ```mermaid block):",
  "- Use IDs with letters/numbers/underscore only (no spaces in node IDs).",
  "- If node labels contain parentheses, brackets, commas, colons, or slashes, wrap the label in double quotes.",
  "- If edge labels contain special characters (including parentheses/brackets), wrap edge labels in double quotes inside pipes.",
  "- Do not emit Mermaid directives: click, style, classDef.",
  "- Prefer: subgraph id [Label] syntax with stable IDs.",
].join("\n");

export function buildWriterMessages(state: GraphState): ChatMessage[] {
  const task = state.task_description ?? "No task provided";
  const jsonMode = writerPrefersJsonMode(state);
  const planBlock = renderPlanContext(state);
  const evidenceBlock = renderEvidenceContext(state);
  const assumptionBlock = buildAssumptionInstructions(state);

  const systemParts = [
    "You are Synesis Writer.",
    "Return only the final user-facing answer; do not expose internal planning scaffolds.",
    "Never emit headings like 'Plan:', 'Evidence:', 'Answer:', 'Draft Response', or similar meta-sections unless the user explicitly asks for that format.",
    "If the prompt is a follow-up request (e.g., 'more detail', 'expand', 'clarify'), extend the answer with new detail instead of repeating prior wording verbatim.",
    "Use citations only when evidence exists and a factual claim depends on it, formatted as [Source: name - [url]].",
    MERMAID_RULES,
    "",
    TRUST_POLICY,
  ];
  if (!jsonMode && evidenceHasWebSources(state)) {
    systemParts.push(
      "When the evidence includes web search results (sources with type \"web\"), start with a concise **Sources consulted** section: at most four bullet lines naming distinct hosts or page titles from that evidence, then a line containing only ---, then the main answer. This is an explicit exception to avoiding meta headings: the preamble is required for transparency when web evidence is present.",
    );
  }
  if (!jsonMode && evidenceHasWebSources(state) && evidenceHasSubstantialSnippets(state)) {
    systemParts.push(
      [
        "WEB GROUNDING (MANDATORY when web evidence excerpts are present):",
        "1. The Evidence block contains text retrieved from live web sources JUST NOW. A 'Retrieved:' timestamp shows when the fetch happened.",
        "2. For time-sensitive topics (weather, forecasts, news, current events, recent releases, prices, scores, comparisons of new products) — ALWAYS synthesize your answer from these excerpts. They are more current than your training data.",
        "3. NEVER say 'I cannot provide real-time information', 'check a website', 'I don't have access to current data', or similar refusals when the Evidence block contains relevant excerpts. You DO have current data — it is in the excerpts.",
        "4. When excerpts contain specific data (temperatures, headlines, version numbers, dates), present that data directly with source attribution.",
        "5. If excerpts are thin or only partially relevant, present what they contain and note what is limited — but still use them.",
        "6. Prefer evidence excerpts over your training knowledge for any fact that could have changed since your training cutoff.",
      ].join("\n"),
    );
  }
  if (jsonMode) {
    systemParts.push(
      "JSON OUTPUT MODE: return only one valid JSON object as the full assistant message.",
      "Do not include markdown fences, prose outside JSON, or trailing commentary.",
    );
  }
  if (assumptionBlock) systemParts.push(assumptionBlock);

  // --- Dynamic taxonomy suffix (prefix-cache: static above, dynamic below) ---
  const taxonomyMeta = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const difficulty = state.difficulty ?? 0;
  const complexity = Number(taxonomyMeta.complexity_score ?? 0);
  const depthInstr = String(taxonomyMeta.depth_instructions ?? "").trim();

  if (complexity > 0.55 && depthInstr) {
    systemParts.push(`\nDOMAIN DEPTH:\n${depthInstr}`);
  }
  const styleGuidance = getOutputStyleGuidance(taxonomyMeta);
  if (styleGuidance) {
    systemParts.push(`\nOUTPUT STYLE:\n${styleGuidance}`);
  }
  if (difficulty >= 0.5) {
    const epistemic = getEpistemicGuidanceBlock(taxonomyMeta);
    if (epistemic) systemParts.push(`\nEPISTEMIC DISCIPLINE:\n${epistemic}`);
  }
  if (difficulty >= 0.4) {
    const discovery = getDiscoveryPrompt(taxonomyMeta);
    if (discovery) systemParts.push(`\nDISCOVERY:\n${discovery}`);
  }
  if (difficulty >= 0.5) {
    const requiredElements = (taxonomyMeta.required_elements ?? []) as string[];
    if (requiredElements.length > 0) {
      const elems = requiredElements.map((e) => `- ${e}`).join("\n");
      systemParts.push(
        "\nDOMAIN COVERAGE CHECKLIST (secondary to the Document Outline above):\n" +
        "The Document Outline is your primary structure. Additionally, ensure " +
        "these domain-mandated topics are covered somewhere in the response " +
        "(they may already appear in the outline):\n" + elems,
      );
    }
  }

  // L2 taxonomy blocks
  const eg = getEpistemicGuidanceBlock(taxonomyMeta);
  if (eg && difficulty >= 0.5) {
    systemParts.push(`\nDISCIPLINE EPISTEMICS (taxonomy):\n${eg}`);
  }
  const wr = getWriterRegulatedBlock(taxonomyMeta);
  if (wr) systemParts.push(`\nREGULATED CONTEXT (taxonomy):\n${wr}`);

  // Vertical persona block
  const activeVertical = String(taxonomyMeta.active_vertical ?? "generic");
  if (activeVertical !== "generic") {
    const snap = getOntologySnapshot();
    const personaBlock = getWorkerPersonaBlock(snap.verticalPrompts, activeVertical, task);
    if (personaBlock) systemParts.push(`\n${personaBlock}`);
  }

  const writerModel =
    state.resolved_writer_model?.trim()
    || process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
    || "Synesis";
  const composedWriterSystem = composePlannerPrompt(systemParts.join(" "), {
    tier: state.model_tier,
    role: "general",
    node: "writer",
    model: writerModel,
  }).content;
  const msgs: ChatMessage[] = [
    { role: "system" as const, content: composedWriterSystem },
  ];

  const conversationHistory = (state.messages ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  if (conversationHistory.length > 1) {
    const prior = conversationHistory.slice(0, -1).slice(-6);
    msgs.push(...prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })));
  }

  const hasEvidence = Boolean(evidenceBlock);
  const wrappedEvidence = hasEvidence
    ? `## Evidence\n${serializeStableJson(makeUntrustedEvidence(evidenceBlock, buildEvidenceAttribution(state)))}\n${SANDWICH_REMINDER}`
    : "";
  const scaffoldParts = [planBlock, wrappedEvidence].filter(Boolean).join("\n\n");
  const userContent = scaffoldParts ? `${task}\n\n${scaffoldParts}` : task;
  msgs.push({ role: "user" as const, content: userContent });

  return msgs;
}

export async function composeWriterDraft(state: GraphState): Promise<WriterResult> {
  const jsonMode = writerPrefersJsonMode(state);
  const fallback = jsonMode ? deterministicJsonDraft(state) : deterministicDraft(state);
  if (!isLlmAvailable()) return { content: fallback, usage: ZERO_USAGE };

  try {
    const result = await chatCompletion({
      model:
        state.resolved_writer_model?.trim()
        || process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
        || "Synesis",
      temperature: 0.2,
      max_tokens: state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
      pricingRates: state.pricing_rates_by_role?.general,
      request_id: state.run_id,
      authz_trace_id: state.authz_trace_id,
      traceparent: state.traceparent,
      response_format: jsonMode ? { type: "json_object" } : undefined,
      messages: buildWriterMessages(state),
    });
    const cfg = loadConfig();
    let content = result.content.trim() || fallback;
    if (!jsonMode && cfg.SYNESIS_PLANNER_TS_WRITER_METADATA_JSON_GUARD && isMetadataTagsOnlyJson(content)) {
      process.stderr.write(JSON.stringify({
        level: 30,
        msg: "writer: replaced metadata-only JSON (tags) with prose fallback",
        time: Date.now(),
      }) + "\n");
      content = fallback;
    }
    if (!cfg.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED || jsonMode) {
      return { content, usage: result.usage };
    }
    const guarded = enforceMermaidHygiene(content);
    return {
      content: guarded.content,
      usage: result.usage,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "writer LLM call failed, using deterministic fallback", error: detail, time: Date.now() }) + "\n");
    return { content: fallback, usage: ZERO_USAGE };
  }
}

/**
 * Streaming variant — calls onDelta for token fragments so the SSE layer can
 * forward them to the client. When the mermaid guard is enabled, the LLM stream
 * is buffered until completion, then sanitized and replayed in chunks; otherwise
 * raw deltas are forwarded (legacy behavior).
 */
export async function composeWriterDraftStream(
  state: GraphState,
  onDelta: (delta: StreamDelta) => void,
): Promise<WriterResult> {
  const jsonMode = writerPrefersJsonMode(state);
  const fallback = jsonMode ? deterministicJsonDraft(state) : deterministicDraft(state);
  if (!isLlmAvailable()) {
    onDelta({ content: fallback });
    return { content: fallback, usage: ZERO_USAGE };
  }

  try {
    const cfg = loadConfig();
    const mermaidGuardEnabled = cfg.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED && !jsonMode;

    const result = await chatCompletionStream(
      {
        model:
          state.resolved_writer_model?.trim()
          || process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
          || "Synesis",
        temperature: 0.2,
        max_tokens: state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
        pricingRates: state.pricing_rates_by_role?.general,
        request_id: state.run_id,
        authz_trace_id: state.authz_trace_id,
        traceparent: state.traceparent,
        response_format: jsonMode ? { type: "json_object" } : undefined,
        messages: buildWriterMessages(state),
      },
      (delta) => {
        if (!mermaidGuardEnabled) {
          onDelta(delta);
          return;
        }
        if (delta.reasoning_content) {
          onDelta({ reasoning_content: delta.reasoning_content });
        }
      },
    );
    let content = result.content.trim() || fallback;
    if (!jsonMode && cfg.SYNESIS_PLANNER_TS_WRITER_METADATA_JSON_GUARD && isMetadataTagsOnlyJson(content)) {
      process.stderr.write(JSON.stringify({
        level: 30,
        msg: "writer stream: metadata-only JSON (tags) detected; appending prose fallback",
        time: Date.now(),
      }) + "\n");
      const repair = `\n\n${fallback}`;
      if (!mermaidGuardEnabled) {
        onDelta({ content: repair });
      }
      content = `${content.trim()}${repair}`;
    }
    if (!mermaidGuardEnabled) {
      return { content, usage: result.usage };
    }
    const guarded = enforceMermaidHygiene(content);
    const finalContent = guarded.content;
    emitWriterStreamingChunks(finalContent, onDelta);
    return {
      content: finalContent,
      usage: result.usage,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "writer streaming LLM call failed, using deterministic fallback", error: detail, time: Date.now() }) + "\n");
    onDelta({ content: fallback });
    return { content: fallback, usage: ZERO_USAGE };
  }
}
