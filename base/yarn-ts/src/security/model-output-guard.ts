import { scanModelOutput, type ScanResult } from "@synesis/context-trust";

export const MODEL_OUTPUT_GUARD_REPLACEMENT =
  "I can't provide hidden or internal instructions. I can help with the user's request without exposing private system or developer content.";

export interface ModelOutputGuardEvent {
  eventKind: "model_output_guardrail_triggered";
  component: "security";
  detail: string;
}

export interface ModelOutputGuardResult {
  text: string;
  detected: boolean;
  scan: ScanResult;
}

export function guardModelOutputText(
  text: string,
  source: string,
  recordEvent?: (event: ModelOutputGuardEvent) => void,
): ModelOutputGuardResult {
  const scan = scanModelOutput(text, source);
  if (!scan.detected) {
    return { text, detected: false, scan };
  }
  recordEvent?.({
    eventKind: "model_output_guardrail_triggered",
    component: "security",
    detail: `Blocked possible prompt leakage in ${source}; pattern_count=${scan.patterns_found.length}; confidence=${scan.confidence.toFixed(2)}`,
  });
  return {
    text: MODEL_OUTPUT_GUARD_REPLACEMENT,
    detected: true,
    scan,
  };
}
