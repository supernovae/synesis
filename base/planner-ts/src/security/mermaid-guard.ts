export interface MermaidViolation {
  code: string;
  detail: string;
}

export interface MermaidFence {
  start: number;
  end: number;
  info: string;
  body: string;
  raw: string;
}

export interface MermaidGuardResult {
  content: string;
  violations: MermaidViolation[];
  changed: boolean;
}

const MERMAID_FENCE_RE = /```[ \t]*mermaid[^\n]*\n([\s\S]*?)```/gi;
const SPECIAL_LABEL_CHARS_RE = /[\s()[\]{}:,/]/;
const FORBIDDEN_DIRECTIVES_RE = /^[ \t]*(?:click|style|classDef)\b/im;
const EDGE_LABEL_RE = /\|([^|\n]+)\|/g;
const NODE_LABEL_RE = /\b([A-Za-z_][A-Za-z0-9_-]*)\[([^\]\n]+)\]/g;
const SUBGRAPH_LABEL_RE = /^([ \t]*subgraph[ \t]+[A-Za-z_][A-Za-z0-9_-]*[ \t]+)\[([^\]\n]+)\]$/gm;

function quoteLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) return trimmed;
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

function normalizeEdgeLabels(block: string): string {
  return block.replace(EDGE_LABEL_RE, (_m, raw: string) => {
    const label = String(raw ?? "").trim();
    if (!label) return `|${raw}|`;
    if (!SPECIAL_LABEL_CHARS_RE.test(label)) return `|${raw}|`;
    if (label.startsWith("\"") && label.endsWith("\"")) return `|${label}|`;
    return `|${quoteLabel(label)}|`;
  });
}

function normalizeNodeLabels(block: string): string {
  return block.replace(NODE_LABEL_RE, (_m, nodeId: string, rawLabel: string) => {
    const label = String(rawLabel ?? "").trim();
    if (!label) return `${nodeId}[${rawLabel}]`;
    if (!SPECIAL_LABEL_CHARS_RE.test(label)) return `${nodeId}[${rawLabel}]`;
    return `${nodeId}[${quoteLabel(label)}]`;
  });
}

function normalizeSubgraphLabels(block: string): string {
  return block.replace(SUBGRAPH_LABEL_RE, (_m, prefix: string, rawLabel: string) => {
    const label = String(rawLabel ?? "").trim();
    if (!label) return `${prefix}[${rawLabel}]`;
    if (!SPECIAL_LABEL_CHARS_RE.test(label)) return `${prefix}[${rawLabel}]`;
    return `${prefix}[${quoteLabel(label)}]`;
  });
}

export function extractMermaidBlocks(text: string): MermaidFence[] {
  const out: MermaidFence[] = [];
  for (const match of text.matchAll(MERMAID_FENCE_RE)) {
    const raw = match[0] ?? "";
    const body = match[1] ?? "";
    const start = match.index ?? -1;
    if (start < 0) continue;
    const end = start + raw.length;
    const infoLine = raw.split("\n", 1)[0] ?? "```mermaid";
    out.push({ start, end, info: infoLine, body, raw });
  }
  return out;
}

export function normalizeMermaidBlock(block: string): string {
  let next = block;
  next = normalizeEdgeLabels(next);
  next = normalizeNodeLabels(next);
  next = normalizeSubgraphLabels(next);
  return next;
}

export function validateMermaidBlock(block: string): MermaidViolation[] {
  const violations: MermaidViolation[] = [];
  if (FORBIDDEN_DIRECTIVES_RE.test(block)) {
    violations.push({
      code: "mermaid_forbidden_directive",
      detail: "Found forbidden Mermaid directive (click/style/classDef).",
    });
  }
  return violations;
}

export function enforceMermaidHygiene(text: string): MermaidGuardResult {
  const fences = extractMermaidBlocks(text);
  if (fences.length === 0) {
    return { content: text, violations: [], changed: false };
  }

  const violations: MermaidViolation[] = [];
  let cursor = 0;
  let output = "";

  for (const fence of fences) {
    output += text.slice(cursor, fence.start);
    const normalized = normalizeMermaidBlock(fence.body);
    const blockViolations = validateMermaidBlock(normalized);
    for (const violation of blockViolations) violations.push(violation);
    output += `${fence.info}\n${normalized}\`\`\``;
    cursor = fence.end;
  }
  output += text.slice(cursor);

  return {
    content: output,
    violations,
    changed: output !== text,
  };
}
