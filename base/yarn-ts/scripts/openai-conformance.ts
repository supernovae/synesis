#!/usr/bin/env tsx
/**
 * OpenAI compatibility conformance harness for Synesis Yarn.
 *
 * This validates the subset we intentionally implement:
 * - GET /v1
 * - GET /v1/models
 * - POST /v1/chat/completions (non-stream + stream)
 * - Authentication and validation error envelopes
 * - Strict system-first acceptance (late system messages are normalized server-side)
 * - Prior assistant tool_call + tool_result transcript acceptance
 *
 * Env:
 *   SYNESIS_YARN_EVAL_URL          Base URL for Yarn (preferred)
 *   SYNESIS_YARN_URL               Fallback base URL
 *   SYNESIS_TEST_PAT_TOKEN         PAT token for authenticated chat endpoint
 *   SYNESIS_TEST_AUTH              PAT fallback
 *   SYNESIS_TEST_TOKEN             PAT fallback
 *   SYNESIS_VERIFY_MODEL           Target model alias (default: synesis-core)
 *   SYNESIS_OPENAI_CONFORMANCE_TIMEOUT_MS  Request timeout (default: 45000)
 *
 * Usage:
 *   npm run verify:openai-conformance
 *   npm run verify:openai-conformance -- --json openai-conformance-report.json
 *   npm run verify:openai-conformance -- --dry-run
 */

import { writeFileSync } from "node:fs";

type CheckResult = {
  name: string;
  pass: boolean;
  latencyMs: number;
  status?: number;
  detail?: string;
};

type Report = {
  url: string;
  model: string;
  startedAt: string;
  durationMs: number;
  checks: CheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
};

type HttpResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const BASE_URL = (process.env.SYNESIS_YARN_EVAL_URL ?? process.env.SYNESIS_YARN_URL ?? "").replace(/\/+$/, "");
const TOKEN = (
  process.env.SYNESIS_TEST_PAT_TOKEN ??
  process.env.SYNESIS_TEST_AUTH ??
  process.env.SYNESIS_TEST_TOKEN ??
  ""
).trim();
const MODEL = process.env.SYNESIS_VERIFY_MODEL ?? "synesis-core";
const TIMEOUT_MS = Number(process.env.SYNESIS_OPENAI_CONFORMANCE_TIMEOUT_MS ?? "45000");

const JSON_OUT = getArgValue("--json");
const DRY_RUN = hasFlag("--dry-run");

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

function snippet(value: string, max = 320): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty body)";
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`;
}

function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function request(
  path: string,
  init: RequestInit = {},
  withAuth = true,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers ?? {});
    if (withAuth && TOKEN) headers.set("Authorization", `Bearer ${TOKEN}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runCheck(
  checks: CheckResult[],
  name: string,
  fn: () => Promise<Omit<CheckResult, "name" | "latencyMs">>,
): Promise<void> {
  const started = Date.now();
  try {
    const result = await fn();
    checks.push({ name, latencyMs: Date.now() - started, ...result });
  } catch (error) {
    checks.push({
      name,
      pass: false,
      latencyMs: Date.now() - started,
      detail: `Unhandled error: ${String(error)}`,
    });
  }
}

async function checkRootMetadata(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const res = await request("/v1", { method: "GET" }, false);
  if (res.status !== 200) {
    return { pass: false, status: res.status, detail: snippet(res.body) };
  }
  const payload = safeJsonParse<Record<string, unknown>>(res.body);
  if (!payload) return { pass: false, status: res.status, detail: "Response is not valid JSON" };

  const endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : [];
  const hasModels = endpoints.includes("/v1/models");
  const hasCompletions = endpoints.includes("/v1/chat/completions");
  if (!hasModels || !hasCompletions) {
    return {
      pass: false,
      status: res.status,
      detail: `Missing expected endpoints in /v1 payload: ${JSON.stringify(endpoints)}`,
    };
  }
  return { pass: true, status: res.status };
}

async function checkModelsList(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const res = await request("/v1/models", { method: "GET" }, false);
  if (res.status !== 200) {
    return { pass: false, status: res.status, detail: snippet(res.body) };
  }
  const payload = safeJsonParse<Record<string, unknown>>(res.body);
  if (!payload) return { pass: false, status: res.status, detail: "Response is not valid JSON" };

  const data = payload.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { pass: false, status: res.status, detail: "Expected non-empty models.data array" };
  }
  const modelIds = data
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === "string");
  if (modelIds.length === 0) {
    return { pass: false, status: res.status, detail: "No model IDs found in /v1/models response" };
  }
  return { pass: true, status: res.status, detail: `models=${modelIds.slice(0, 8).join(", ")}` };
}

async function checkChatAuthRequired(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const payload = {
    model: MODEL,
    stream: false,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  };
  const res = await request(
    "/v1/chat/completions",
    { method: "POST", body: JSON.stringify(payload) },
    false,
  );
  if (res.status !== 401) {
    return {
      pass: false,
      status: res.status,
      detail: `Expected 401 without Authorization header, got ${res.status}: ${snippet(res.body)}`,
    };
  }
  return { pass: true, status: res.status };
}

async function checkChatNonStreamBasic(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const payload = {
    model: MODEL,
    stream: false,
    max_tokens: 32,
    messages: [
      { role: "system", content: "Respond with exactly OK." },
      { role: "user", content: "Say OK." },
    ],
  };
  const res = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) return { pass: false, status: res.status, detail: snippet(res.body) };

  const parsed = safeJsonParse<Record<string, unknown>>(res.body);
  if (!parsed) return { pass: false, status: res.status, detail: "Response is not valid JSON" };

  const object = parsed.object;
  const choices = parsed.choices;
  const usage = parsed.usage as Record<string, unknown> | undefined;
  if (object !== "chat.completion") {
    return { pass: false, status: res.status, detail: `Expected object=chat.completion, got ${String(object)}` };
  }
  if (!Array.isArray(choices) || choices.length === 0) {
    return { pass: false, status: res.status, detail: "Expected non-empty choices array" };
  }
  if (!usage || typeof usage.total_tokens !== "number") {
    return { pass: false, status: res.status, detail: "Expected OpenAI usage fields in non-stream response" };
  }
  return { pass: true, status: res.status };
}

async function checkLateSystemAccepted(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const payload = {
    model: MODEL,
    stream: false,
    max_tokens: 48,
    messages: [
      { role: "user", content: "Reply with exactly OK." },
      { role: "system", content: "You must respond with OK only." },
    ],
  };
  const res = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    return {
      pass: false,
      status: res.status,
      detail: `Late-system transcript rejected: ${snippet(res.body)}`,
    };
  }
  return { pass: true, status: res.status };
}

async function checkToolHistoryAccepted(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const payload = {
    model: MODEL,
    stream: false,
    max_tokens: 64,
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: "Please summarize the file output." },
      {
        role: "assistant",
        content: "I used Read to inspect the file.",
        tool_calls: [
          {
            id: "call_hist_1",
            type: "function",
            function: {
              name: "Read",
              arguments: "{\"file_path\":\"README.md\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        name: "Read",
        tool_call_id: "call_hist_1",
        content: "# README\nThis repository contains Synesis services.",
      },
      { role: "user", content: "Summarize that in one sentence." },
    ],
  };
  const res = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    return {
      pass: false,
      status: res.status,
      detail: `Tool history rejected: ${snippet(res.body)}`,
    };
  }
  return { pass: true, status: res.status };
}

async function checkStreamChunks(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const payload = {
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 32,
    messages: [
      { role: "system", content: "Respond with exactly OK." },
      { role: "user", content: "Say OK." },
    ],
  };
  const res = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) return { pass: false, status: res.status, detail: snippet(res.body) };

  const dataLines = res.body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter(Boolean);

  if (dataLines.length === 0) {
    return { pass: false, status: res.status, detail: "No SSE data lines received" };
  }
  if (!dataLines.includes("[DONE]")) {
    return { pass: false, status: res.status, detail: "Missing [DONE] stream terminator" };
  }
  const firstJson = dataLines.find((line) => line !== "[DONE]");
  if (!firstJson) {
    return { pass: false, status: res.status, detail: "No JSON chunks in stream output" };
  }
  const parsed = safeJsonParse<Record<string, unknown>>(firstJson);
  if (!parsed || parsed.object !== "chat.completion.chunk") {
    return {
      pass: false,
      status: res.status,
      detail: `Expected chat.completion.chunk payload, got: ${firstJson.slice(0, 200)}`,
    };
  }
  return { pass: true, status: res.status };
}

async function checkInvalidPayloadReturns400(): Promise<Omit<CheckResult, "name" | "latencyMs">> {
  const res = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: MODEL, stream: false }),
  });
  if (res.status !== 400) {
    return {
      pass: false,
      status: res.status,
      detail: `Expected 400 invalid payload, got ${res.status}: ${snippet(res.body)}`,
    };
  }
  const parsed = safeJsonParse<Record<string, unknown>>(res.body);
  const errorType = (parsed?.error as Record<string, unknown> | undefined)?.type;
  if (errorType !== "invalid_request_error") {
    return {
      pass: false,
      status: res.status,
      detail: `Expected error.type=invalid_request_error, got ${String(errorType)}`,
    };
  }
  return { pass: true, status: res.status };
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log(JSON.stringify({
      dryRun: true,
      baseUrl: BASE_URL || "(unset)",
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
      tokenConfigured: TOKEN.length > 0,
      jsonOut: JSON_OUT,
    }, null, 2));
    return;
  }

  if (!BASE_URL) {
    console.error("Missing SYNESIS_YARN_EVAL_URL (or SYNESIS_YARN_URL).");
    process.exit(1);
  }
  if (!TOKEN) {
    console.error("Missing SYNESIS_TEST_PAT_TOKEN (or SYNESIS_TEST_AUTH / SYNESIS_TEST_TOKEN).");
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const checks: CheckResult[] = [];

  await runCheck(checks, "GET /v1 metadata", checkRootMetadata);
  await runCheck(checks, "GET /v1/models shape", checkModelsList);
  await runCheck(checks, "POST /v1/chat/completions requires auth", checkChatAuthRequired);
  await runCheck(checks, "POST /v1/chat/completions non-stream shape", checkChatNonStreamBasic);
  await runCheck(checks, "POST /v1/chat/completions accepts late system input", checkLateSystemAccepted);
  await runCheck(checks, "POST /v1/chat/completions accepts assistant tool history", checkToolHistoryAccepted);
  await runCheck(checks, "POST /v1/chat/completions stream chunk protocol", checkStreamChunks);
  await runCheck(checks, "POST /v1/chat/completions invalid payload returns 400", checkInvalidPayloadReturns400);

  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;

  const report: Report = {
    url: BASE_URL,
    model: MODEL,
    startedAt,
    durationMs: Date.now() - t0,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
    },
  };

  for (const check of checks) {
    const status = check.status ? ` [${check.status}]` : "";
    const detail = check.detail ? ` — ${check.detail}` : "";
    console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}${status}${detail}`);
  }
  console.log(`Summary: ${passed}/${checks.length} passed`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`Report written to ${JSON_OUT}`);
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("OpenAI conformance harness failed:", error);
  process.exit(2);
});
