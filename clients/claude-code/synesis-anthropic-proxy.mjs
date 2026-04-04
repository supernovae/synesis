#!/usr/bin/env node
/**
 * Minimal local reverse proxy: merges Synesis session context from
 * .claude/synesis-context.json (written by synesis-context-hook.sh) into
 * POST /v1/messages and /v1/chat/completions body.metadata, then forwards to Yarn.
 *
 * Env:
 *   SYNESIS_UPSTREAM   — required, e.g. https://coder.example.com (no /v1 suffix)
 *   SYNESIS_CONTEXT_FILE — optional, default: $cwd/.claude/synesis-context.json
 *   SYNESIS_PROXY_PORT — default 8787
 *   SYNESIS_PROXY_HOST — default 127.0.0.1
 *
 * Usage:
 *   export SYNESIS_UPSTREAM=https://your-yarn-host
 *   node synesis-anthropic-proxy.mjs
 *   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
 */
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.SYNESIS_PROXY_PORT || "8787");
const BIND = process.env.SYNESIS_PROXY_HOST || "127.0.0.1";
const UPSTREAM = (process.env.SYNESIS_UPSTREAM || "").trim().replace(/\/$/, "");
const CONTEXT_FILE =
  process.env.SYNESIS_CONTEXT_FILE || join(process.cwd(), ".claude", "synesis-context.json");

if (!UPSTREAM) {
  console.error("synesis-anthropic-proxy: set SYNESIS_UPSTREAM to your Yarn base URL (no /v1 suffix).");
  process.exit(1);
}

function loadContext() {
  try {
    const raw = readFileSync(CONTEXT_FILE, "utf8");
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

function mergeSynesisMetadata(body, ctx) {
  if (!ctx || typeof body !== "object" || body === null) return body;
  const meta =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? { ...body.metadata }
      : {};
  for (const k of ["synesis_project_root", "synesis_shell_cwd", "synesis_git_summary"]) {
    if (typeof ctx[k] === "string" && ctx[k].length) meta[k] = ctx[k];
  }
  if (ctx.synesis_runtime && typeof ctx.synesis_runtime === "object") {
    meta.synesis_runtime = {
      ...(typeof meta.synesis_runtime === "object" && meta.synesis_runtime !== null
        ? meta.synesis_runtime
        : {}),
      ...ctx.synesis_runtime,
    };
  }
  return { ...body, metadata: meta };
}

function forwardHeaders(incoming) {
  const out = {};
  const skip = new Set(["host", "connection", "content-length", "transfer-encoding"]);
  for (const [k, v] of Object.entries(incoming)) {
    if (skip.has(k.toLowerCase())) continue;
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.length) out[k] = v.join(", ");
  }
  return out;
}

function forwardRequest(req, res, bodyBuf) {
  const base = new URL(UPSTREAM);
  const isHttps = base.protocol === "https:";
  const lib = isHttps ? https : http;
  const pathWithQuery = req.url || "/";

  const headers = forwardHeaders(req.headers);
  headers.host = base.host;

  const opts = {
    hostname: base.hostname,
    port: base.port || (isHttps ? 443 : 80),
    path: pathWithQuery,
    method: req.method || "GET",
    headers,
  };

  if (bodyBuf && bodyBuf.length) {
    opts.headers["content-length"] = String(bodyBuf.length);
  }

  const preq = lib.request(opts, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(String(err));
  });
  if (bodyBuf && bodyBuf.length) preq.write(bodyBuf);
  preq.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const url = req.url || "/";
    const shouldMerge =
      req.method === "POST" &&
      (url.startsWith("/v1/messages") || url.startsWith("/v1/chat/completions"));
    let bodyBuf = raw;
    if (shouldMerge && raw.length) {
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        const ctx = loadContext();
        bodyBuf = Buffer.from(JSON.stringify(mergeSynesisMetadata(parsed, ctx)), "utf8");
      } catch {
        // forward unchanged
      }
    }
    forwardRequest(req, res, bodyBuf);
  });
});

server.listen(PORT, BIND, () => {
  console.error(
    `synesis-anthropic-proxy: listening http://${BIND}:${PORT} -> ${UPSTREAM} (context: ${CONTEXT_FILE})`,
  );
});
