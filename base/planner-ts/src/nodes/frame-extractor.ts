/**
 * Frame Extractor — 2-stage pipeline for structured task decomposition.
 *
 * Stage 1 (parallel): LLM semantic unit extraction + GLiNER2 NER enrichment
 * Stage 2 (deterministic): Link units into a TaskFrame, build topic_frame
 *   and domain profile.
 *
 * Ports the Python frame_extractor_node from frame_extractor.py.
 *
 * Design references:
 *   Klein (2007) Data-Frame theory: fit data into frames
 *   Snowden & Boone (2007) Cynefin: focused/composite/diffuse
 */

import type { GraphState } from "../state/types.js";
import { chatCompletion, isLlmAvailable } from "../llm/client.js";
import type { PricingRates } from "@synesis/telemetry";
import { extractGliner, type GlinerExtractionResult } from "./gliner-client.js";
import { buildDomainProfile } from "./domain-profile.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FrameUnit {
  text: string;
  type: "goal" | "task" | "constraint" | "context" | "dependency" | "evaluation";
}

interface ScopedTask {
  id: string;
  description: string;
  artifacts: string[];
  constraints: string[];
  dependencies: string[];
}

interface TaskFrame {
  goals: string[];
  tasks: ScopedTask[];
  global_constraints: string[];
  negative_constraints: string[];
  context: string[];
  evaluation: string[];
  main_question: string;
  requested_format: string;
  output_schema: string[];
  embedded_formats: string[];
  domain_tags: string[];
  technologies: string[];
  needs_web: boolean;
  persona: string;
  topic_frame: string;
}

// ---------------------------------------------------------------------------
// Stage 1a: LLM semantic unit extraction
// ---------------------------------------------------------------------------

const SEGMENT_SYSTEM = `You are a semantic segmenter. Break the user prompt into atomic units.
Each unit expresses exactly one intent, requirement, constraint, or fact.
Classify each as: goal, task, constraint, context, dependency, evaluation.

Rules:
- goal: the high-level outcome the user wants
- task: a discrete deliverable or section the user expects
- constraint: a limit, restriction, boundary, or format requirement
- context: background information, team size, timeline, technology stack
- dependency: ordering between tasks ("X depends on Y", "before doing Z")
- evaluation: success criteria, quality instructions, how to judge the result

Do NOT merge unrelated ideas into one unit.
Do NOT infer requirements the user never stated.
Do NOT paraphrase — preserve the user's language.
If a sentence contains multiple distinct requirements, split them.

Output JSON: {"units": [{"text": "...", "type": "goal|task|constraint|context|dependency|evaluation"}]}`;

const VALID_UNIT_TYPES = new Set(["goal", "task", "constraint", "context", "dependency", "evaluation"]);

async function llmSegment(text: string, pricingRates?: PricingRates): Promise<FrameUnit[]> {
  if (!isLlmAvailable()) return [];

  try {
    const result = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "synesis-writer",
      temperature: 0,
      max_tokens: 1200,
      pricingRates,
      messages: [
        { role: "system", content: SEGMENT_SYSTEM },
        { role: "user", content: text.slice(0, 3000) },
      ],
    });
    const parsed = JSON.parse(result.content) as { units?: Array<{ text?: string; type?: string }> };
    return (parsed.units ?? [])
      .filter((u) => u.text?.trim())
      .map((u) => ({
        text: u.text!.trim(),
        type: (VALID_UNIT_TYPES.has(u.type ?? "") ? u.type! : "context") as FrameUnit["type"],
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Deterministic semantic linking
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persona detection (port of _detect_persona from frame_extractor.py)
// ---------------------------------------------------------------------------

const PERSONA_PATTERNS: Array<{ pattern: RegExp; template: string; skipCheck: boolean }> = [
  { pattern: /\blike\s+a\s+(\w+)\b/i, template: "{0}", skipCheck: false },
  { pattern: /\bas\s+(?:a|an)\s+(\w+)\b/i, template: "{0}", skipCheck: false },
  { pattern: /\bin\s+(?:the\s+)?(?:style|voice|tone)\s+of\s+(?:a\s+)?(\w+)/i, template: "{0}", skipCheck: false },
  { pattern: /\bexplain\s+(?:it\s+)?to\s+(?:a\s+)?(\d+)[\s-]*year[\s-]*old\b/i, template: "ELI{0}", skipCheck: true },
  { pattern: /\bexplain\s+(?:it\s+)?(?:like|as if)\s+(?:I'?m|i am)\s+(?:a\s+)?(\w+)\b/i, template: "{0}", skipCheck: false },
];

const PERSONA_STOPWORDS = new Set([
  "the", "a", "an", "it", "this", "that", "my", "your", "me", "way",
  "much", "more", "well", "also", "very", "how", "what", "why", "can",
  "do", "should", "would", "could", "will", "following", "possible",
]);

function detectPersona(rawText: string): string {
  for (const { pattern, template, skipCheck } of PERSONA_PATTERNS) {
    const match = pattern.exec(rawText);
    if (match) {
      const captured = match[1].trim().toLowerCase();
      if (skipCheck || (!PERSONA_STOPWORDS.has(captured) && captured.length > 1)) {
        return template.replace("{0}", captured).slice(0, 40);
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Constraint / artifact / format detection
// ---------------------------------------------------------------------------

const GLOBAL_CONSTRAINT_RE = /\b(all|every|each|always|never|entire|whole|throughout)\b/i;
const EVIDENCE_RE =
  /\b(cite|evidence|sources?|references?|RAG|retriev|ground|search\s+the\s+web|web\s+search|look\s+up\s+online)\b/i;
const ARTIFACT_TYPE_RE = /\b(json|yaml|yml|xml|csv|toml|code|diagram|mermaid|table|sql)\b/gi;
const NEGATIVE_RE = /^(do not|don't|never|avoid|no |must not|should not|cannot)\b/i;

const FORMAT_PATTERNS: Record<string, RegExp> = {
  table: /\b(?:table|matrix|grid|spreadsheet)\b/i,
  code: /\b(?:code|snippet|script|implementation|function|class)\b/i,
  diagram: /\b(?:diagram|chart|graph|flowchart|mermaid|uml)\b/i,
  bullet_list: /\b(?:bullet|list|numbered|enumerat)\b/i,
  json: /\bjson\b/i,
  yaml: /\b(?:yaml|yml)\b/i,
  xml: /\b(?:xml|xhtml)\b/i,
  csv: /\b(?:csv|tsv)\b/i,
  toml: /\btoml\b/i,
};

const STRUCTURED_FORMATS = new Set(["json", "yaml", "xml", "csv", "toml"]);

const PURE_STRUCTURED_RE = new RegExp(
  "(?:^|\\b)(?:" +
    "(?:output|respond|return|reply|format|write)\\s+" +
    "(?:(?:it|this|that|the response|everything)\\s+)?" +
    "(?:only\\s+|exclusively\\s+|purely\\s+|strictly\\s+|as\\s+|in\\s+)?" +
    "(?:valid\\s+|pure\\s+)?" +
    "(?:json|yaml|yml|xml|csv|toml)" +
    "|" +
    "(?:json|yaml|yml|xml|csv|toml)\\s+only" +
    "|" +
    "(?:give\\s+me|i\\s+(?:want|need))\\s+(?:only\\s+)?(?:(?:the|a)\\s+)?" +
    "(?:raw\\s+|valid\\s+|pure\\s+)?" +
    "(?:json|yaml|yml|xml|csv|toml)(?:\\s+output|\\s+response|\\s+document)?" +
    "(?:\\s+only)?" +
    ")",
  "i",
);

const SCHEMA_FIELD_RE = /"(\w+)"\s*:/g;

function detectFormat(rawText: string, glinerFormats: string[]): { requested: string; embedded: string[] } {
  let requested = "prose";
  const embedded: string[] = [];

  if (glinerFormats.length > 0) {
    const fmtText = glinerFormats[0].toLowerCase().trim();
    let matched = false;
    for (const [fmt, pattern] of Object.entries(FORMAT_PATTERNS)) {
      if (pattern.test(fmtText)) {
        requested = fmt;
        matched = true;
        break;
      }
    }
    if (!matched) requested = fmtText;
  } else {
    for (const [fmt, pattern] of Object.entries(FORMAT_PATTERNS)) {
      if (pattern.test(rawText)) {
        if (STRUCTURED_FORMATS.has(fmt)) {
          if (PURE_STRUCTURED_RE.test(rawText)) requested = fmt;
          else embedded.push(fmt);
        } else {
          requested = fmt;
        }
        break;
      }
    }
  }

  return { requested, embedded: [...new Set(embedded)] };
}

function detectOutputSchema(rawText: string, format: string, embedded: string[]): string[] {
  if (!STRUCTURED_FORMATS.has(format) && embedded.length === 0) return [];
  const fields: string[] = [];
  for (const block of rawText.matchAll(/\{[^{}]{10,}\}/g)) {
    for (const m of block[0].matchAll(SCHEMA_FIELD_RE)) {
      if (!fields.includes(m[1])) fields.push(m[1]);
    }
  }
  return fields;
}

function linkUnitsToFrame(
  units: FrameUnit[],
  rawText: string,
  gliner: GlinerExtractionResult,
): TaskFrame {
  const goals: string[] = [];
  const tasks: ScopedTask[] = [];
  const globalConstraints: string[] = [];
  const negativeConstraints: string[] = [];
  const contextItems: string[] = [];
  const evaluationItems: string[] = [];
  let needsEvidence = false;
  let taskCounter = 0;
  let currentTask: ScopedTask | undefined;

  for (const unit of units) {
    const text = unit.text.trim();
    if (!text) continue;

    switch (unit.type) {
      case "goal":
        goals.push(text);
        break;
      case "task": {
        const id = `task_${taskCounter++}`;
        const artifacts = [...new Set((text.match(ARTIFACT_TYPE_RE) ?? []).map((m) => m.toLowerCase()))];
        currentTask = { id, description: text, artifacts, constraints: [], dependencies: [] };
        tasks.push(currentTask);
        break;
      }
      case "constraint":
        if (NEGATIVE_RE.test(text)) {
          negativeConstraints.push(text);
        } else if (!currentTask || GLOBAL_CONSTRAINT_RE.test(text)) {
          globalConstraints.push(text);
        } else {
          currentTask.constraints.push(text);
        }
        break;
      case "context":
        contextItems.push(text);
        break;
      case "dependency":
        if (currentTask) currentTask.dependencies.push(text);
        else contextItems.push(text);
        break;
      case "evaluation":
        evaluationItems.push(text);
        break;
    }

    if (EVIDENCE_RE.test(text)) needsEvidence = true;
  }

  let mainQuestion = goals[0] ?? "";
  if (!mainQuestion && tasks.length > 0) mainQuestion = tasks[0].description;
  if (!mainQuestion) mainQuestion = rawText.trim().split("\n")[0].slice(0, 300);

  const glinerFormats = gliner.formats.map((f) => f.text);
  const { requested, embedded } = detectFormat(rawText, glinerFormats);
  const outputSchema = detectOutputSchema(rawText, requested, embedded);
  const domainTags = [...new Set(gliner.domain_tags.map((d) => d.text))];
  const technologies = [...new Set(gliner.technologies.map((t) => t.text))];

  const topicParts: string[] = [];
  if (mainQuestion) topicParts.push(mainQuestion);
  for (const t of tasks) {
    if (t.description.toLowerCase() !== mainQuestion.toLowerCase()) {
      topicParts.push(t.description);
    }
  }
  let topicFrame = topicParts.join("; ");
  if (domainTags.length > 0) topicFrame += ` [${domainTags.slice(0, 4).join(", ")}]`;
  topicFrame = topicFrame.slice(0, 1000);

  return {
    goals,
    tasks,
    global_constraints: globalConstraints,
    negative_constraints: negativeConstraints,
    context: contextItems,
    evaluation: evaluationItems,
    main_question: mainQuestion,
    requested_format: requested,
    output_schema: outputSchema,
    embedded_formats: embedded,
    domain_tags: domainTags,
    technologies,
    needs_web: needsEvidence,
    persona: detectPersona(rawText),
    topic_frame: topicFrame,
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no GLiNER, no LLM)
// ---------------------------------------------------------------------------

function buildDeterministicFrame(taskDescription: string, taxonomyKey: string): TaskFrame {
  const firstLine = taskDescription.trim().split("\n")[0].slice(0, 200);
  const { requested, embedded } = detectFormat(taskDescription, []);
  const outputSchema = detectOutputSchema(taskDescription, requested, embedded);
  const domainTags = taxonomyKey && taxonomyKey !== "generic" && taxonomyKey !== "general"
    ? [taxonomyKey]
    : [];

  return {
    goals: firstLine ? [firstLine] : [],
    tasks: [],
    global_constraints: [],
    negative_constraints: [],
    context: [],
    evaluation: [],
    main_question: firstLine,
    requested_format: requested,
    output_schema: outputSchema,
    embedded_formats: embedded,
    domain_tags: domainTags,
    technologies: [],
    needs_web: false,
    persona: detectPersona(taskDescription),
    topic_frame: firstLine,
  };
}

// ---------------------------------------------------------------------------
// Main node
// ---------------------------------------------------------------------------

export async function frameExtractorNode(state: GraphState): Promise<GraphState> {
  const taskDescription = state.task_description ?? "";
  const difficulty = state.difficulty ?? 0.5;
  const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const taxonomyKey = String(taxonomy.taxonomy_key ?? "general");
  const glinerUrl = process.env.SYNESIS_GLINER_SERVICE_URL ?? "";

  if (difficulty < 0.15 || !taskDescription.trim()) {
    const frame = buildDeterministicFrame(taskDescription, taxonomyKey);
    return {
      ...state,
      task_frame: frame as unknown as Record<string, unknown>,
    };
  }

  const [units, gliner] = await Promise.all([
    llmSegment(taskDescription, state.pricing_rates_by_role?.router),
    extractGliner(taskDescription, glinerUrl),
  ]);

  let taskFrame: TaskFrame;
  if (units.length === 0 && gliner.technologies.length === 0 && gliner.domain_tags.length === 0) {
    taskFrame = buildDeterministicFrame(taskDescription, taxonomyKey);
  } else {
    taskFrame = linkUnitsToFrame(units, taskDescription, gliner);
  }

  if (taskFrame.domain_tags.length === 0 && taxonomyKey !== "generic" && taxonomyKey !== "general") {
    taskFrame.domain_tags = [taxonomyKey];
  }

  const domainProfile = buildDomainProfile(
    [taskDescription, ...taskFrame.technologies, ...taskFrame.domain_tags].join(" "),
  );

  return {
    ...state,
    task_frame: taskFrame as unknown as Record<string, unknown>,
    domain_profile: domainProfile,
  };
}
