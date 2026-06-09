import { createHash } from "node:crypto";

import { normalizeAbsolutePathHint } from "../path-governance/path-hints.js";

function hashKeyPart(label: string, value: string, chars = 32): string {
  return `${label}-${createHash("sha256").update(value).digest("hex").slice(0, chars)}`;
}

export function canonicalMemoryProjectRoot(projectRoot: string | null | undefined): string {
  const normalized = normalizeAbsolutePathHint(projectRoot);
  if (normalized) return normalized;
  const raw = typeof projectRoot === "string" ? projectRoot.replace(/\0/g, "").trim() : "";
  if (raw === "no-workspace" || /^invalid-workspace-[a-f0-9]{32}$/.test(raw)) return raw;
  return raw ? hashKeyPart("invalid-workspace", raw) : "no-workspace";
}

export function canonicalMemoryNamespace(namespace: string | null | undefined): string | undefined {
  const raw = namespace?.replace(/\0/g, "").trim();
  if (!raw) return undefined;
  if (raw.length <= 160 && /^[A-Za-z0-9_.:@-]+$/.test(raw)) return raw;
  return hashKeyPart("namespace", raw);
}

export function safeMemoryCachePart(value: string | null | undefined, label: string, maxEncodedLength = 180): string {
  const raw = value?.replace(/\0/g, "").trim() || label;
  if (!/^[A-Za-z0-9_.:@/+%-]+$/.test(raw)) return hashKeyPart(label, raw, 64);
  const encoded = encodeURIComponent(raw);
  if (encoded.length <= maxEncodedLength) return encoded;
  return hashKeyPart(label, raw, 64);
}
