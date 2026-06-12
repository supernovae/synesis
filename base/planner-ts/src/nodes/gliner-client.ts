/**
 * GLiNER extraction microservice HTTP client.
 *
 * Calls /extract with a predefined entity schema and returns typed
 * extraction results (technologies, domain tags, formats, etc.).
 * GLiNER HTTP client used by frame extraction.
 */

export interface ExtractionCandidate {
  text: string;
  confidence: number;
}

export interface GlinerExtractionResult {
  technologies: ExtractionCandidate[];
  domain_tags: ExtractionCandidate[];
  formats: ExtractionCandidate[];
  requirements: ExtractionCandidate[];
  constraints: ExtractionCandidate[];
  deliverables: ExtractionCandidate[];
  classification: string;
}

const EXTRACTION_SCHEMA = {
  entities: {
    requirement: "Something the user wants produced, answered, or decided",
    constraint: "A limit, restriction, boundary, or negative requirement",
    deliverable: "An explicit output artifact or section the user expects",
    technology: "A specific tool, framework, language, or platform mentioned",
    timeline: "A deadline, urgency signal, or time constraint",
    domain_hint: "Subject area or industry context",
    quality_instruction: "How to respond — style, tone, format, uncertainty handling",
    negative_constraint: "Something to avoid or not do",
    decision_signal: "Request to choose, rank, compare, or recommend",
    escalation_signal: "Uncertainty, safety, or evidence sensitivity cue",
    output_format: "Requested format — table, code, bullet list, diagram, email",
  },
  classification: {
    categories: [
      "decision_required",
      "information_request",
      "creative_task",
      "technical_task",
      "planning_task",
    ],
  },
};

const LABEL_TO_FIELD: Record<string, keyof Pick<GlinerExtractionResult,
  "technologies" | "domain_tags" | "formats" | "requirements" | "constraints" | "deliverables">> = {
  technology: "technologies",
  domain_hint: "domain_tags",
  output_format: "formats",
  requirement: "requirements",
  constraint: "constraints",
  deliverable: "deliverables",
};

interface SpanResult {
  text: string;
  confidence?: number;
  start?: number;
  end?: number;
}

interface ExtractResponse {
  entities?: Record<string, SpanResult[]>;
  classification?: string;
}

const _cache = new Map<string, GlinerExtractionResult>();
const CACHE_MAX = 64;

function cacheKey(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

export async function extractGliner(
  text: string,
  glinerUrl: string,
  options: { threshold?: number; timeoutMs?: number } = {},
): Promise<GlinerExtractionResult> {
  const threshold = options.threshold ?? 0.4;
  const timeoutMs = options.timeoutMs ?? 20000;
  const key = cacheKey(text.slice(0, 5000));

  const cached = _cache.get(key);
  if (cached) return cached;

  if (!glinerUrl) return emptyResult();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${glinerUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        schema: EXTRACTION_SCHEMA,
        threshold,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return emptyResult();

    const data = (await resp.json()) as ExtractResponse;
    const entities = data.entities ?? {};
    const classification = data.classification ?? "";

    const result: GlinerExtractionResult = {
      technologies: [],
      domain_tags: [],
      formats: [],
      requirements: [],
      constraints: [],
      deliverables: [],
      classification,
    };

    for (const [label, field] of Object.entries(LABEL_TO_FIELD)) {
      const spans = entities[label] ?? [];
      result[field] = spans.map((s) => ({
        text: s.text,
        confidence: s.confidence ?? 0,
      }));
    }

    _cache.set(key, result);
    if (_cache.size > CACHE_MAX) {
      const first = _cache.keys().next().value;
      if (first !== undefined) _cache.delete(first);
    }

    return result;
  } catch {
    return emptyResult();
  } finally {
    clearTimeout(timer);
  }
}

function emptyResult(): GlinerExtractionResult {
  return {
    technologies: [],
    domain_tags: [],
    formats: [],
    requirements: [],
    constraints: [],
    deliverables: [],
    classification: "",
  };
}
