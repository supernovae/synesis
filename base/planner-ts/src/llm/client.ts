type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

function llmEnabled(): boolean {
  return (process.env.SYNESIS_PLANNER_TS_LLM_ENABLED ?? "false").toLowerCase() === "true";
}

function llmConfig() {
  return {
    baseUrl: (process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL ?? "").trim(),
    apiKey: (process.env.SYNESIS_PLANNER_TS_LLM_API_KEY ?? "").trim(),
    timeoutMs: Number(process.env.SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS ?? 15000)
  };
}

export function isLlmAvailable(): boolean {
  const { baseUrl } = llmConfig();
  return llmEnabled() && baseUrl.length > 0;
}

export async function chatCompletion(request: ChatRequest): Promise<string> {
  const { baseUrl, apiKey, timeoutMs } = llmConfig();
  if (!isLlmAvailable()) {
    throw new Error("LLM is not enabled");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0,
        max_tokens: request.max_tokens
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned empty content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}
