export interface PromptInjectionScorerConfig {
  url: string;
  authToken?: string;
  timeoutMs?: number;
  model?: string;
}

export interface PromptInjectionScoreResult {
  status: "scored" | "timeout" | "error";
  score: number;
  label: string;
  model: string;
  source: string;
  latency_ms: number;
  error?: string;
}

const DEFAULT_MODEL = "meta-llama/Llama-Prompt-Guard-2-86M";
const MALICIOUS_LABELS = new Set(["malicious", "injection", "jailbreak", "label_1", "1"]);
const BENIGN_LABELS = new Set(["benign", "label_0", "0"]);

function errorResult(
  status: "timeout" | "error",
  source: string,
  model: string,
  startedAt: number,
  error: unknown,
): PromptInjectionScoreResult {
  return {
    status,
    score: 0,
    label: "unknown",
    model,
    source,
    latency_ms: Date.now() - startedAt,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 256),
  };
}

function parseScore(payload: unknown): { score: number; label: string } {
  const rows = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : payload;
  if (!Array.isArray(rows)) throw new Error("scorer response must be a classification array");

  const labels = rows.filter((row): row is { label: string; score: number } =>
    typeof row === "object"
    && row !== null
    && typeof (row as Record<string, unknown>).label === "string"
    && typeof (row as Record<string, unknown>).score === "number"
    && Number.isFinite((row as Record<string, unknown>).score)
  );
  const malicious = labels
    .filter((row) => MALICIOUS_LABELS.has(row.label.toLowerCase()))
    .sort((a, b) => b.score - a.score)[0];
  if (malicious) return { score: Math.min(1, Math.max(0, malicious.score)), label: malicious.label };

  const benign = labels.find((row) => BENIGN_LABELS.has(row.label.toLowerCase()));
  if (benign) return { score: Math.min(1, Math.max(0, 1 - benign.score)), label: benign.label };
  throw new Error("scorer response has no supported labels");
}

export async function scorePromptInjection(
  text: string,
  source: string,
  config: PromptInjectionScorerConfig,
): Promise<PromptInjectionScoreResult> {
  const startedAt = Date.now();
  const model = config.model?.trim() || DEFAULT_MODEL;
  try {
    const url = new URL(config.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("scorer URL must use HTTP(S)");
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(config.authToken ? { authorization: `Bearer ${config.authToken}` } : {}),
      },
      body: JSON.stringify({ inputs: text.slice(0, 8_000) }),
      signal: AbortSignal.timeout(Math.max(50, Math.min(config.timeoutMs ?? 1_000, 10_000))),
    });
    if (!response.ok) throw new Error(`scorer HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 64_000) throw new Error("scorer response too large");
    const parsed = parseScore(JSON.parse(body));
    return {
      status: "scored",
      ...parsed,
      model,
      source: source.slice(0, 128),
      latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
    return errorResult(timedOut ? "timeout" : "error", source.slice(0, 128), model, startedAt, error);
  }
}
