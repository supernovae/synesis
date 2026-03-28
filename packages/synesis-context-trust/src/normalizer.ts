/**
 * Text normalization for evasion-resistant pattern matching.
 *
 * Handles Unicode homoglyphs (Cyrillic/fullwidth lookalikes), zero-width
 * character stripping, and base64-encoded payload detection.
 *
 * Port of guardrails_core/normalizer.py — keep in sync.
 */

const CONFUSABLE_MAP: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
  "\u04bb": "h", "\u0501": "d",
  "\uff49": "i", "\uff47": "g", "\uff4e": "n", "\uff4f": "o",
  "\uff52": "r", "\uff45": "e",
};

const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u2060\ufeff]/g;
const B64_CANDIDATE_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

export function normalizeConfusables(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    const replacement = CONFUSABLE_MAP[ch];
    if (replacement) {
      out.push(replacement);
    } else if (ch.charCodeAt(0) > 127) {
      const normalized = ch.normalize("NFKD");
      let ascii = "";
      for (const c of normalized) {
        if (c.charCodeAt(0) <= 127) ascii += c;
      }
      out.push(ascii || ch);
    } else {
      out.push(ch);
    }
  }
  return out.join("");
}

export function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH_RE, "");
}

export function normalizeForScan(text: string): string {
  return normalizeConfusables(stripZeroWidth(text));
}

export function detectBase64Payloads(
  text: string,
  probePatterns: RegExp[],
  maxChars = 16_000,
): string[] {
  const findings: string[] = [];
  const chunk = text.slice(0, maxChars);
  B64_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = B64_CANDIDATE_RE.exec(chunk)) !== null) {
    try {
      const decoded = Buffer.from(match[0], "base64").toString("utf-8");
      if (decoded.length > 10) {
        for (const pat of probePatterns) {
          if (pat.test(decoded)) {
            const src = pat.source.slice(0, 60);
            findings.push(`base64_encoded:${src}`);
            break;
          }
        }
      }
    } catch {
      continue;
    }
  }
  return findings;
}
