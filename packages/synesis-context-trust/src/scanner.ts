/**
 * Unified pattern scanner — TS port of guardrails_core/scanner.py.
 *
 * Three tiers of compiled patterns:
 *   Tier 1 (core): instruction override, jailbreak, template injection
 *   Tier 2 (web/indirect): encoded payloads, link injection, hidden text, prompt leaking
 *   Tier 3 (output): signs the model complied with an injection
 *
 * Keep pattern lists in sync with the Python implementation.
 */

import { normalizeForScan, detectBase64Payloads } from "./normalizer.js";

// ---------------------------------------------------------------------------
// Tier 1: Core injection patterns
// ---------------------------------------------------------------------------
const CORE_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/i,
  /forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told/i,
  /new\s+instructions?\s*:/i,
  /override\s+(?:your\s+)?(?:instructions?|prompt)/i,
  /you\s+are\s+now\s+(?:a|an)\s/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if\s+you/i,
  /(?:^|\n)\s*system\s*:\s*(?:ignore|disregard|forget|override|follow\s+these\s+instructions|you\s+are\s+now|pretend|act\s+as)/i,
  /<\|im_start\|>\s*system/i,
  /###\s*human\s*:/i,
  /\[INST\]\s*/i,
  /<\/?s(?:ystem)?>/i,
  /ignore\s+the\s+above/i,
  /ignore\s+above\b/i,
  /follow\s+these\s+instructions?\s+instead/i,
  /output\s+(?:only|just)\s+the\s+following/i,
  /print\s+(?:exactly|only)\s+this\s*:/i,
  /(?:DAN|developer)\s+mode\s+(?:enabled|activated|on)/i,
  /(?:do\s+anything\s+now|unlimited\s+mode)/i,
];

// ---------------------------------------------------------------------------
// Tier 2: Extended patterns (web, indirect injection, obfuscation)
// ---------------------------------------------------------------------------
const WEB_PATTERNS: RegExp[] = [
  /base64[:\s]+[A-Za-z0-9+/=]{20,}/i,
  /\[[^\]\r\n]{0,2048}\]\(\s*javascript\s*:/i,
  /<a\b[^>\r\n]{0,2048}\bhref\s*=\s*["']?\s*javascript:/i,
  /[\u200b\u200c\u200d\u2060\ufeff]{3,}/,
  /data:text\/html[;,]/i,
  /(?:reveal|show|print|repeat|echo)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions)/i,
  /from\s+now\s+on\s+(?:you\s+)?(?:are|will|must|should)\b/i,
  /(?:assistant|ai|model)\s*:\s*(?:sure|okay|yes|I will)/i,
  /<!--\s*(?:system|instruction|prompt)/i,
];

// ---------------------------------------------------------------------------
// Tier 3: Output compliance indicators
// ---------------------------------------------------------------------------
const OUTPUT_PATTERNS: RegExp[] = [
  /(?:^|\n)\s*system\s*:\s*(?:you\s+are|ignore|disregard|forget|override|follow\s+these\s+instructions)/i,
  /(?:my|the)\s+system\s+prompt\s+(?:is|says|reads)/i,
  /(?:here\s+(?:is|are)\s+)?my\s+(?:original\s+)?instructions?:/i,
  /I\s+(?:will|can|shall)\s+now\s+(?:act|behave|operate)\s+as/i,
  /(?:DAN|developer)\s+mode\s+(?:enabled|activated)/i,
  /<\|im_start\|>/i,
];

const CODE_NOISE_PATTERNS: RegExp[] = [
  /^(show|print|repeat|echo)\s+(?:system\s+)?prompt$/i,
  /^(show|print|repeat|echo)\s+instructions?$/i,
];

const CORE_REDACTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/gi,
  /forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told/gi,
  /new\s+instructions?\s*:/gi,
  /override\s+(?:your\s+)?(?:instructions?|prompt)/gi,
  /you\s+are\s+now\s+(?:a|an)\s/gi,
  /pretend\s+you\s+are/gi,
  /act\s+as\s+if\s+you/gi,
  /(?:^|\n)\s*system\s*:\s*(?:ignore|disregard|forget|override|follow\s+these\s+instructions|you\s+are\s+now|pretend|act\s+as)/gi,
  /<\|im_start\|>\s*system/gi,
  /###\s*human\s*:/gi,
  /\[INST\]\s*/gi,
  /<\/?s(?:ystem)?>/gi,
  /ignore\s+the\s+above/gi,
  /ignore\s+above\b/gi,
  /follow\s+these\s+instructions?\s+instead/gi,
  /output\s+(?:only|just)\s+the\s+following/gi,
  /print\s+(?:exactly|only)\s+this\s*:/gi,
  /(?:DAN|developer)\s+mode\s+(?:enabled|activated|on)/gi,
  /(?:do\s+anything\s+now|unlimited\s+mode)/gi,
];

const WEB_REDACTION_PATTERNS: RegExp[] = [
  /base64[:\s]+[A-Za-z0-9+/=]{20,}/gi,
  /\[[^\]\r\n]{0,2048}\]\(\s*javascript\s*:/gi,
  /<a\b[^>\r\n]{0,2048}\bhref\s*=\s*["']?\s*javascript:/gi,
  /[\u200b\u200c\u200d\u2060\ufeff]{3,}/g,
  /data:text\/html[;,]/gi,
  /(?:reveal|show|print|repeat|echo)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/gi,
  /what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions)/gi,
  /from\s+now\s+on\s+(?:you\s+)?(?:are|will|must|should)\b/gi,
  /(?:assistant|ai|model)\s*:\s*(?:sure|okay|yes|I will)/gi,
  /<!--\s*(?:system|instruction|prompt)/gi,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventType =
  | "system_override_attempt"
  | "jailbreak_roleplay"
  | "context_confusion_attack"
  | "code_exec_risk"
  | "prompt_leakage_attempt"
  | "unknown";

export interface ScanResult {
  detected: boolean;
  patterns_found: string[];
  source: string;
  excerpt: string;
  tier: string;
  confidence: number;
  event_type: EventType;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function classifyPatterns(patternsFound: string[]): EventType {
  const joined = patternsFound.join(" ").toLowerCase();
  if (["ignore", "disregard", "override", "new instructions"].some((w) => joined.includes(w)))
    return "system_override_attempt";
  if (["dan", "pretend", "act as", "you are now", "unlimited"].some((w) => joined.includes(w)))
    return "jailbreak_roleplay";
  if (["reveal", "show", "print", "repeat", "echo", "prompt", "instructions"].some((w) => joined.includes(w)))
    return "prompt_leakage_attempt";
  if (["base64", "javascript", "data:text"].some((w) => joined.includes(w)))
    return "code_exec_risk";
  if (["im_start", "inst", "system:"].some((w) => joined.includes(w)))
    return "context_confusion_attack";
  return "unknown";
}

function runPatterns(text: string, patterns: RegExp[], maxChars = 32_000): string[] {
  const found: string[] = [];
  const chunk = text.slice(0, maxChars);
  for (const pat of patterns) {
    const m = pat.exec(chunk);
    if (m) found.push(m[0].slice(0, 80));
  }
  return found;
}

function excerptAround(text: string, patterns: RegExp[], maxChars = 32_000): string {
  const chunk = text.slice(0, maxChars);
  for (const pat of patterns) {
    const m = pat.exec(chunk);
    if (m) {
      const start = Math.max(0, m.index - 50);
      const end = Math.min(chunk.length, m.index + m[0].length + 50);
      return chunk.slice(start, end).replace(/\n/g, " ");
    }
  }
  return "";
}

function isCodeLike(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample.trim()) return false;
  const lines = sample.split(/\r?\n/).slice(0, 80);
  let score = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(\/\/|#|\/\*|\*|--)\s*/.test(line)) score += 1;
    if (/[{}()[\];]/.test(line)) score += 1;
    if (/(^|\s)(func|class|def|const|let|var|return|if|for|while|import|export|package)\b/.test(line)) score += 1;
    if (/[:=]-?=?|=>/.test(line)) score += 1;
    if (/\b[A-Za-z_]\w*\s*\(/.test(line)) score += 1;
  }
  return score >= 4;
}

function filterCodeNoise(matches: string[]): string[] {
  return matches.filter((m) => !CODE_NOISE_PATTERNS.some((pat) => pat.test(m.trim())));
}

// ---------------------------------------------------------------------------
// Public scan functions
// ---------------------------------------------------------------------------

export function scanText(text: string, source = "unknown", maxScanChars = 32_000): ScanResult {
  if (!text) return { detected: false, patterns_found: [], source, excerpt: "", tier: "core", confidence: 0, event_type: "unknown" };
  const found = runPatterns(text, CORE_PATTERNS, maxScanChars);
  const excerpt = found.length > 0 ? excerptAround(text, CORE_PATTERNS, maxScanChars) : "";
  const eventType = found.length > 0 ? classifyPatterns(found) : "unknown";
  const confidence = found.length > 0 ? Math.min(0.5 + 0.15 * found.length, 1.0) : 0;
  return { detected: found.length > 0, patterns_found: found, source, excerpt, tier: "core", confidence, event_type: eventType };
}

export function scanWebContent(text: string, source = "web", maxScanChars = 32_000): ScanResult {
  if (!text) return { detected: false, patterns_found: [], source, excerpt: "", tier: "web", confidence: 0, event_type: "unknown" };

  const rawWebFound = runPatterns(text.slice(0, maxScanChars), WEB_PATTERNS, maxScanChars);
  const normalized = normalizeForScan(text);
  const coreFound = runPatterns(normalized, CORE_PATTERNS, maxScanChars);
  const webFound = runPatterns(normalized, WEB_PATTERNS, maxScanChars);

  const seen = new Set(webFound);
  for (const f of rawWebFound) {
    if (!seen.has(f)) {
      webFound.push(f);
      seen.add(f);
    }
  }

  const b64Found = detectBase64Payloads(text, CORE_PATTERNS, maxScanChars);
  let allFound = [...coreFound, ...webFound, ...b64Found];
  if (isCodeLike(text)) {
    allFound = filterCodeNoise(allFound);
  }
  const excerpt = allFound.length > 0 ? excerptAround(normalized, [...CORE_PATTERNS, ...WEB_PATTERNS], maxScanChars) : "";
  const eventType = allFound.length > 0 ? classifyPatterns(allFound) : "unknown";
  const confidence = allFound.length > 0 ? Math.min(0.5 + 0.12 * allFound.length, 1.0) : 0;
  return { detected: allFound.length > 0, patterns_found: allFound, source, excerpt, tier: "web", confidence, event_type: eventType };
}

export function scanModelOutput(text: string, source = "model_output"): ScanResult {
  if (!text) return { detected: false, patterns_found: [], source, excerpt: "", tier: "output", confidence: 0, event_type: "unknown" };
  const found = runPatterns(text, OUTPUT_PATTERNS, 16_000);
  const excerpt = found.length > 0 ? excerptAround(text, OUTPUT_PATTERNS, 16_000) : "";
  const confidence = found.length > 0 ? Math.min(0.6 + 0.15 * found.length, 1.0) : 0;
  return { detected: found.length > 0, patterns_found: found, source, excerpt, tier: "output", confidence, event_type: found.length > 0 ? "prompt_leakage_attempt" : "unknown" };
}

export function redactPatterns(text: string, includeWeb = false): string {
  const patterns = includeWeb ? [...CORE_REDACTION_PATTERNS, ...WEB_REDACTION_PATTERNS] : CORE_REDACTION_PATTERNS;
  let result = text;
  for (const pat of patterns) {
    result = result.replace(pat, "[REDACTED]");
  }
  return result;
}

/**
 * Scan user input and recent conversation history for injection.
 * Returns [detected, scanDetails].
 */
export function scanUserInput(
  userContent: string,
  conversationHistory: string[],
): [boolean, { detected: boolean; patterns_found: string[]; source: string }] {
  const results: ScanResult[] = [];

  if (userContent) {
    const r = scanText(userContent, "user_message");
    results.push(r);
  }

  for (let i = 0; i < conversationHistory.length; i++) {
    if (conversationHistory[i]) {
      const r = scanText(conversationHistory[i], `history_${i}`);
      if (r.detected) results.push(r);
    }
  }

  const detected = results.some((r) => r.detected);
  const allPatterns = results.flatMap((r) => r.patterns_found);
  return [detected, { detected, patterns_found: allPatterns, source: results[0]?.source ?? "user_message" }];
}
