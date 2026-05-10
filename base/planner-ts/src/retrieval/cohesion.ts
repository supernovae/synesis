/**
 * Cohesion Lock Engine — post-retrieval inter-document coherence filtering.
 *
 * Ports the Python cohesion.py:
 *   Phase 5b: detectCohesionLock (deterministic metadata + LLM fallback)
 *   Phase 5c: cohesionFilter (embedding tier + parallel LLM micro-critic)
 *   Phase 5d: compressToCohesion (sentence-level extraction)
 *
 * Conflict groups loaded from embedded data (ported from cohesion_groups.yaml).
 */

import type { CohesionLockData, UnifiedResult } from "./types.js";
import { embed, dotProduct, l2Normalize } from "./embedder.js";
import { chatCompletion, isLlmAvailable } from "../llm/client.js";

export interface CohesionConfig {
  enabled: boolean;
  minResults: number;
  embeddingThreshold: number;
  llmBorderlineLow: number;
  llmBorderlineHigh: number;
  compressionThreshold: number;
  embedderUrl: string;
  embedderModel: string;
}

// ---------------------------------------------------------------------------
// Conflict groups (embedded from cohesion_groups.yaml)
// ---------------------------------------------------------------------------

interface ConflictGroup {
  members: string[];
  aliases?: Record<string, string[]>;
}

const CONFLICT_GROUPS: Record<string, ConflictGroup> = {
  cloud_provider: {
    members: ["aws", "amazon", "gcp", "google cloud", "azure", "microsoft azure"],
    aliases: { aws: ["amazon web services"], gcp: ["google cloud platform"], azure: ["microsoft azure"] },
  },
  container_orchestration: {
    members: ["kubernetes", "openshift", "docker swarm", "nomad"],
    aliases: { kubernetes: ["k8s"], openshift: ["okd"] },
  },
  ml_framework: {
    members: ["pytorch", "tensorflow", "jax"],
    aliases: { pytorch: ["torch"] },
  },
  frontend_framework: {
    members: ["react", "angular", "vue", "svelte", "solid"],
    aliases: { react: ["reactjs"], angular: ["angularjs"], vue: ["vuejs"] },
  },
  automotive_brand: {
    members: ["ford", "chevy", "chevrolet", "toyota", "honda", "bmw"],
    aliases: { chevy: ["chevrolet"] },
  },
  programming_language: {
    members: ["python", "java", "go", "rust", "typescript", "csharp"],
    aliases: { csharp: ["c#", "dotnet"], typescript: ["ts"], go: ["golang"] },
  },
  database: {
    members: ["postgresql", "mysql", "mongodb", "redis", "cassandra", "dynamodb"],
    aliases: { postgresql: ["postgres"] },
  },
  cloud_compute: {
    members: ["ec2", "compute engine", "azure vm", "fargate", "cloud run", "azure functions", "lambda"],
  },
  llm_provider: {
    members: ["openai", "anthropic", "google", "mistral", "meta", "cohere"],
    aliases: { openai: ["gpt", "chatgpt"], anthropic: ["claude"], google: ["gemini"], meta: ["llama"] },
  },
};

let _entityExclusionMap: Record<string, string[]> | null = null;
let _memberToGroup: Map<string, string[]> | null = null;

function entityExclusionMap(): Record<string, string[]> {
  if (_entityExclusionMap) return _entityExclusionMap;

  const map: Record<string, string[]> = {};
  for (const group of Object.values(CONFLICT_GROUPS)) {
    const allNames = new Set<string>();
    for (const m of group.members) allNames.add(m.toLowerCase());
    if (group.aliases) {
      for (const aliases of Object.values(group.aliases)) {
        for (const a of aliases) allNames.add(a.toLowerCase());
      }
    }
    const members = [...allNames];
    for (const m of members) {
      map[m] = members.filter((other) => other !== m);
    }
  }
  _entityExclusionMap = map;
  return map;
}

function memberToGroupMap(): Map<string, string[]> {
  if (_memberToGroup) return _memberToGroup;

  const m = new Map<string, string[]>();
  for (const [groupName, group] of Object.entries(CONFLICT_GROUPS)) {
    for (const member of group.members) {
      const key = member.toLowerCase();
      const existing = m.get(key) ?? [];
      existing.push(groupName);
      m.set(key, existing);
    }
    if (group.aliases) {
      for (const aliases of Object.values(group.aliases)) {
        for (const alias of aliases) {
          const key = alias.toLowerCase();
          const existing = m.get(key) ?? [];
          existing.push(groupName);
          m.set(key, existing);
        }
      }
    }
  }
  _memberToGroup = m;
  return m;
}

export function getConflictGroups(): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const [name, group] of Object.entries(CONFLICT_GROUPS)) {
    const members = new Set<string>();
    for (const m of group.members) members.add(m.toLowerCase());
    if (group.aliases) {
      for (const aliases of Object.values(group.aliases)) {
        for (const a of aliases) members.add(a.toLowerCase());
      }
    }
    result[name] = members;
  }
  return result;
}

export function buildExclusionSignals(entity: string): string[] {
  return entityExclusionMap()[entity.toLowerCase()] ?? [];
}

// ---------------------------------------------------------------------------
// Phase 5b: Cohesion Lock Detection
// ---------------------------------------------------------------------------

function detectFromMetadata(results: UnifiedResult[], topN: number): CohesionLockData | null {
  const top = results.slice(0, topN);
  const allNames = entityExclusionMap();
  const entityPattern = new RegExp(
    Object.keys(allNames)
      .filter((k) => k.length > 2)
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "gi",
  );

  const counts = new Map<string, number>();
  for (const doc of top) {
    const text = `${doc.document_name ?? ""} ${doc.heading_path ?? ""} ${doc.title ?? ""}`.toLowerCase();
    for (const match of text.matchAll(entityPattern)) {
      const entity = match[0].toLowerCase();
      counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return null;

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topEntity, topCount] = sorted[0];
  if (topCount < 2) return null;

  return {
    entity: topEntity,
    type: "specific",
    exclude_signals: buildExclusionSignals(topEntity),
    confidence: Math.min(topCount / topN, 1),
    source: "metadata",
  };
}

async function detectFromLlm(results: UnifiedResult[], topN: number): Promise<CohesionLockData | null> {
  if (!isLlmAvailable()) return null;

  const docs = results.slice(0, topN);
  const summaries = docs
    .map((d, i) => `Doc ${i + 1}: ${d.text.slice(0, 200)}`)
    .join("\n---\n");

  try {
    const result = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "synesis-writer",
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: "system", content: "You classify document sets. Output only JSON." },
        {
          role: "user",
          content: [
            `These ${docs.length} documents were retrieved for a user query.`,
            "Determine if they share a dominant entity (e.g. a specific technology, brand, framework).",
            "If yes, output JSON: {\"entity\": \"<name>\", \"type\": \"generic\"|\"specific\", \"exclude_signals\": [\"<competing entities>\"]}",
            "If no dominant entity, output: {\"entity\": \"\"}",
            "",
            summaries,
          ].join("\n"),
        },
      ],
    });
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    const entity = String(parsed.entity ?? "");
    if (!entity) return null;

    return {
      entity,
      type: (parsed.type === "specific" ? "specific" : "generic") as "generic" | "specific",
      exclude_signals: Array.isArray(parsed.exclude_signals)
        ? (parsed.exclude_signals as string[]).map(String)
        : buildExclusionSignals(entity),
      confidence: 0.7,
      source: "llm",
    };
  } catch {
    return null;
  }
}

export async function detectCohesionLock(
  results: UnifiedResult[],
  topN = 3,
): Promise<CohesionLockData | null> {
  const metadataLock = detectFromMetadata(results, topN);
  if (metadataLock) return metadataLock;
  return detectFromLlm(results, topN);
}

// ---------------------------------------------------------------------------
// Phase 5c: Cohesion Filter
// ---------------------------------------------------------------------------

export async function cohesionFilter(
  results: UnifiedResult[],
  lock: CohesionLockData,
  config: CohesionConfig,
  protectedTopN = 3,
): Promise<UnifiedResult[]> {
  if (results.length <= protectedTopN) return results;

  const protectedDocs = results.slice(0, protectedTopN);
  const candidates = results.slice(protectedTopN);

  if (!config.embedderUrl || candidates.length === 0) {
    return regexFilter(results, lock);
  }

  const lockText = lock.entity;
  const candidateTexts = candidates.map((c) => c.text.slice(0, 200));
  const allTexts = [lockText, ...candidateTexts];

  let embeddings: number[][];
  try {
    embeddings = await embed(allTexts, { url: config.embedderUrl, model: config.embedderModel });
  } catch {
    return regexFilter(results, lock);
  }

  const lockVec = l2Normalize(embeddings[0]);
  const kept: UnifiedResult[] = [...protectedDocs];

  for (let i = 0; i < candidates.length; i++) {
    const docVec = l2Normalize(embeddings[i + 1]);
    const sim = dotProduct(lockVec, docVec);

    if (sim >= config.llmBorderlineHigh) {
      kept.push(candidates[i]);
    } else if (sim < config.embeddingThreshold) {
      continue;
    } else if (isLlmAvailable()) {
      const keep = await microCriticSingle(candidates[i], lock);
      if (keep) kept.push(candidates[i]);
    }
  }

  return regexFilter(kept, lock);
}

function regexFilter(results: UnifiedResult[], lock: CohesionLockData): UnifiedResult[] {
  if (lock.exclude_signals.length === 0) return results;
  const pattern = new RegExp(
    lock.exclude_signals
      .filter((s) => s.length > 2)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "i",
  );
  return results.filter((r) => !pattern.test(r.text.slice(0, 500)));
}

async function microCriticSingle(doc: UnifiedResult, lock: CohesionLockData): Promise<boolean> {
  try {
    const result = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "synesis-writer",
      temperature: 0,
      max_tokens: 128,
      messages: [
        { role: "system", content: "Classify document relevance. Output only JSON." },
        {
          role: "user",
          content: [
            `The retrieval set is about "${lock.entity}".`,
            `Exclude signals: ${lock.exclude_signals.slice(0, 5).join(", ")}`,
            `Document preview: ${doc.text.slice(0, 300)}`,
            'Does this document belong? Output: {"keep": true/false, "reason": "..."}',
          ].join("\n"),
        },
      ],
    });
    const parsed = JSON.parse(result.content) as { keep?: boolean };
    return parsed.keep !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Phase 5d: Compress to Cohesion
// ---------------------------------------------------------------------------

export async function compressToCohesion(
  results: UnifiedResult[],
  lock: CohesionLockData,
  config: CohesionConfig,
): Promise<UnifiedResult[]> {
  if (!config.embedderUrl || results.length === 0) return results;

  const lockText = lock.entity;
  const allSentences: Array<{ resultIdx: number; sentence: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const sentences = results[i].text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
    for (const sentence of sentences) {
      allSentences.push({ resultIdx: i, sentence });
    }
  }

  if (allSentences.length === 0) return results;

  const textsToEmbed = [lockText, ...allSentences.map((s) => s.sentence)];

  let embeddings: number[][];
  try {
    embeddings = await embed(textsToEmbed, { url: config.embedderUrl, model: config.embedderModel });
  } catch {
    return results;
  }

  const lockVec = l2Normalize(embeddings[0]);
  const keptByResult = new Map<number, string[]>();

  for (let i = 0; i < allSentences.length; i++) {
    const sentVec = l2Normalize(embeddings[i + 1]);
    const sim = dotProduct(lockVec, sentVec);
    if (sim >= config.compressionThreshold) {
      const idx = allSentences[i].resultIdx;
      const existing = keptByResult.get(idx) ?? [];
      existing.push(allSentences[i].sentence);
      keptByResult.set(idx, existing);
    }
  }

  return results.map((r, i) => {
    const keptSentences = keptByResult.get(i);
    if (!keptSentences) return r;
    const originalSentences = r.text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
    if (keptSentences.length < originalSentences.length * 0.3) return r;
    return { ...r, text: keptSentences.join(" ") };
  });
}
