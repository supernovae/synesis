import type { JsonCompactionResult } from "../reduction/json-compactor.js";
import type { DetectedContentType } from "../reduction/content-dispatch.js";

export type EnrichmentTask =
  | { type: "compact_json"; raw: string; maxOutputItems?: number }
  | { type: "detect_content"; raw: string }
  | { type: "compress_log"; raw: string; maxLines?: number }
  | { type: "summarize_json"; raw: string; maxChars?: number };

export type EnrichmentResult =
  | { type: "compact_json"; result: JsonCompactionResult | null }
  | { type: "detect_content"; contentType: DetectedContentType; transformed: string | null }
  | { type: "compress_log"; compressed: string }
  | { type: "summarize_json"; summary: string };
