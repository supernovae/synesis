const CLASSIFY_TIMEOUT_MS = 30_000;
function plannerBaseUrl(config) {
    return config.SYNESIS_PLANNER_URL.replace(/\/$/, "");
}
function authHeaders(token) {
    const h = {};
    if (token.trim()) {
        h.Authorization = `Bearer ${token.trim()}`;
    }
    return h;
}
export function createClassifyTool(config) {
    return {
        name: "synesis_classify",
        description: "Classify a task description. Returns intent_class, is_code_task, difficulty, task_size, and taxonomy metadata from the planner entry classifier.",
        inputSchema: {
            type: "object",
            properties: {
                task: { type: "string", description: "The task or prompt to classify" },
            },
            required: ["task"],
        },
        handler: async (args) => {
            try {
                const task = String(args.task ?? "").trim();
                if (!task) {
                    return { error: "validation_error", message: "task is required" };
                }
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
                let resp;
                try {
                    resp = await fetch(`${plannerBaseUrl(config)}/v1/chat/completions`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Synesis-MCP": "classify-only",
                            ...authHeaders(config.SYNESIS_INTERNAL_SERVICE_TOKEN),
                        },
                        body: JSON.stringify({
                            model: "Synesis",
                            messages: [{ role: "user", content: task }],
                            stream: false,
                            max_tokens: 1,
                        }),
                        signal: controller.signal,
                    });
                }
                finally {
                    clearTimeout(t);
                }
                let payload;
                try {
                    payload = await resp.json();
                }
                catch {
                    payload = { parse_error: true, status: resp.status };
                }
                if (!resp.ok) {
                    return {
                        error: "classify_failed",
                        status: resp.status,
                        detail: payload,
                    };
                }
                return payload;
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                const aborted = e instanceof Error && e.name === "AbortError";
                return {
                    error: aborted ? "timeout" : "request_failed",
                    message,
                };
            }
        },
    };
}
//# sourceMappingURL=classify.js.map