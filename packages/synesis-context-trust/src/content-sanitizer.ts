/**
 * Content sanitizer — strip fake control tags, truncate, detect imperative language.
 */

const FAKE_CONTROL_TAGS = [
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\/?s(?:ystem)?>/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /###\s*(?:system|human|assistant)\s*:/gi,
];

const IMPERATIVE_PHRASES = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/i,
  /new\s+instructions?\s*:/i,
  /override\s+(?:your\s+)?(?:instructions?|prompt)/i,
  /you\s+are\s+now\s+(?:a|an)\s/i,
  /pretend\s+you\s+are/i,
  /from\s+now\s+on\s+(?:you\s+)?(?:are|will|must|should)\b/i,
  /follow\s+these\s+instructions?\s+instead/i,
  /output\s+(?:only|just)\s+the\s+following/i,
];

export interface SanitizeResult {
  text: string;
  applied: string[];
  imperativeLikelihood: number;
}

export function sanitize(
  text: string,
  opts: { maxLength?: number; stripBoilerplate?: boolean } = {},
): SanitizeResult {
  const maxLen = opts.maxLength ?? 100_000;
  const applied: string[] = [];
  let result = text;

  if (result.length > maxLen) {
    result = result.slice(0, maxLen);
    applied.push("truncated");
  }

  for (const pattern of FAKE_CONTROL_TAGS) {
    const before = result;
    result = result.replace(pattern, "");
    if (result !== before) {
      applied.push("stripped_control_tags");
      break;
    }
  }

  if (opts.stripBoilerplate) {
    const before = result.length;
    result = result.replace(/^[-=]{3,}\s*$/gm, "");
    if (result.length < before) applied.push("stripped_boilerplate");
  }

  const imperativeLikelihood = estimateImperativeLikelihood(result);

  return { text: result, applied, imperativeLikelihood };
}

export function estimateImperativeLikelihood(text: string): number {
  if (!text) return 0;
  const sample = text.slice(0, 16_000);
  let matches = 0;
  for (const pat of IMPERATIVE_PHRASES) {
    if (pat.test(sample)) matches++;
  }
  return Math.min(matches / IMPERATIVE_PHRASES.length, 1.0);
}
