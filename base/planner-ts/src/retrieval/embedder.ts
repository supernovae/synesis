/**
 * TEI embedder HTTP client.
 *
 * Calls the Text Embeddings Inference service (OpenAI-compatible /v1/embeddings).
 * Matches the Python embed_client pattern in rag_client.py / embed_client.py.
 */

export interface EmbedderConfig {
  url: string;
  model: string;
  timeoutMs?: number;
}

interface EmbeddingItem {
  embedding: number[];
  index?: number;
}

interface EmbeddingsResponse {
  data: EmbeddingItem[];
}

export async function embed(
  texts: string[],
  config: EmbedderConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { url, model, timeoutMs = 10000 } = config;
  if (!url) return texts.map(() => []);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts, model }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedder HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as EmbeddingsResponse;
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item) => item.embedding);
  } finally {
    clearTimeout(timer);
  }
}

export function dotProduct(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

export function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
