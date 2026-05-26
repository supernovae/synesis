import type { AppConfig } from "../config.js";

export function createMaxOutputTokenSafetyClamp(
  config: Pick<AppConfig, "SYNESIS_YARN_MAX_OUTPUT_TOKENS_SAFETY_CEILING">,
): (tokens: number) => number {
  return (tokens) => {
    const ceiling = config.SYNESIS_YARN_MAX_OUTPUT_TOKENS_SAFETY_CEILING;
    if (!ceiling || ceiling <= 0) return tokens;
    return Math.min(tokens, ceiling);
  };
}
