export type RequirementPriority = "must" | "should";

export interface RequirementItem {
  id: string;
  title: string;
  priority: RequirementPriority;
  coverageTerms: string[];
  minimumTermMatches: number;
}

export interface RequirementChecklist {
  version: number;
  sourceHash: string;
  sourcePreview: string;
  createdAt: number;
  must: RequirementItem[];
  should: RequirementItem[];
}

export interface RequirementCoverageReport {
  matchedIds: string[];
  missingMust: RequirementItem[];
  missingShould: RequirementItem[];
}

const SPLIT_RE = /[.\n;]+|\s+and\s+(?=(?:be able to|able to|output|support|use|resume|add|modify|generate)\b)/gi;
const ACTION_RE = /\b(use|support|output|export|resume|load|save|generate|present|plan|calculate|add|modify|integrate|fetch)\b/i;
const LEADING_PHRASES = [
  /^in (?:this|the) [^,.:;]+[, ]*/i,
  /^this tool should(?: consider)?\s+/i,
  /^this calculator(?: should)?\s+/i,
  /^create (?:an?|the)\s+/i,
  /^i(?:'d| would)? like (?:to|it to)\s+/i,
  /^(?:it|tool|calculator)\s+should\s+/i,
  /^(?:it|tool|calculator)\s+must\s+/i,
  /^(?:it|tool|calculator)\s+needs?\s+to\s+/i,
  /^allows? me to\s+/i,
  /^be able to\s+/i,
  /^able to\s+/i,
];
const STOP_TERMS = new Set([
  "the", "and", "with", "from", "that", "this", "have", "into", "your", "their", "then",
  "will", "would", "should", "must", "need", "needs", "able", "allow", "allows", "using",
  "use", "create", "build", "make", "tool", "calculator", "output", "support", "present",
  "screen", "file", "files", "well", "formatted", "include", "includes", "for", "on",
]);

function canonicalToken(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower.length > 3 && lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}

function cleanPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeClause(raw: string): string {
  let clause = raw.replace(/\s+/g, " ").trim();
  for (const re of LEADING_PHRASES) clause = clause.replace(re, "");
  clause = clause.replace(/^to\s+/i, "").replace(/\s+/g, " ").trim();
  return clause;
}

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const c = canonicalToken(w);
    if (c.length < 3) continue;
    if (STOP_TERMS.has(c)) continue;
    if (/^\d+$/.test(w)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    deduped.push(c);
  }
  return deduped.slice(0, 10);
}

function priorityForClause(raw: string): RequirementPriority {
  if (/\b(optional|nice to have|if possible|could)\b/i.test(raw)) return "should";
  if (/\b(create|build|present|display|accordingly|formatted|cli)\b/i.test(raw)) return "should";
  return "must";
}

export function buildChecklistFromPrompt(prompt: string, sourceHash: string): RequirementChecklist {
  const source = cleanPreview(prompt);
  const rawClauses = prompt
    .split(SPLIT_RE)
    .map((c) => normalizeClause(c))
    .filter((c) => c.length >= 12 && ACTION_RE.test(c));
  const seenTitles = new Set<string>();
  const items: RequirementItem[] = [];
  for (let i = 0; i < rawClauses.length; i++) {
    const title = rawClauses[i];
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    const coverageTerms = tokenize(title);
    if (coverageTerms.length === 0) continue;
    const minimumTermMatches = Math.max(1, Math.min(2, Math.ceil(coverageTerms.length * 0.34)));
    items.push({
      id: `req_${i + 1}`,
      title,
      priority: priorityForClause(rawClauses[i]),
      coverageTerms,
      minimumTermMatches,
    });
  }
  const must = items.filter((i) => i.priority === "must");
  const should = items.filter((i) => i.priority === "should");
  return {
    version: 1,
    sourceHash,
    sourcePreview: source,
    createdAt: Date.now(),
    must,
    should,
  };
}

export function evaluateRequirementCoverage(
  checklist: RequirementChecklist,
  evidenceText: string,
): RequirementCoverageReport {
  const text = evidenceText.toLowerCase().replace(/\s+/g, " ").trim();
  const evidenceTokens = new Set(tokenize(text));
  const matched = new Set<string>();
  const covered = (item: RequirementItem): boolean => {
    if (item.coverageTerms.length === 0) return false;
    let hits = 0;
    for (const term of item.coverageTerms) {
      if (evidenceTokens.has(canonicalToken(term))) hits += 1;
    }
    const ok = hits >= item.minimumTermMatches;
    if (ok) matched.add(item.id);
    return ok;
  };
  const missingMust = checklist.must.filter((item) => !covered(item));
  const missingShould = checklist.should.filter((item) => !covered(item));
  return {
    matchedIds: [...matched],
    missingMust,
    missingShould,
  };
}

export function summarizeMissingCoverage(report: RequirementCoverageReport): string {
  const missing = [...report.missingMust, ...report.missingShould];
  if (missing.length === 0) return "";
  return missing.map((m) => `- ${m.title}`).join("\n");
}
