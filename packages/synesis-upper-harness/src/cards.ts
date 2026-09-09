import {
  HARNESS_CARD_SCHEMA_VERSION,
  HarnessCardV1Schema,
  type HarnessCardV1,
} from "./types.js";

const COMMON_CODING_TOOL_ARGUMENT_ALIASES: HarnessCardV1["repairs"]["argument_aliases"] = {
  Write: {
    path: "file_path",
    filename: "file_path",
    file: "file_path",
    filepath: "file_path",
    text: "content",
    code: "content",
    file_content: "content",
    body: "content",
  },
  Read: {
    path: "file_path",
    filename: "file_path",
    file: "file_path",
    filepath: "file_path",
  },
  Edit: {
    path: "file_path",
    filename: "file_path",
    file: "file_path",
    filepath: "file_path",
    find: "old_string",
    search: "old_string",
    replace: "new_string",
    replacement: "new_string",
  },
  Update: {
    path: "file_path",
    filename: "file_path",
    file: "file_path",
    filepath: "file_path",
    find: "old_string",
    search: "old_string",
    replace: "new_string",
    replacement: "new_string",
  },
  Bash: {
    cmd: "command",
    script: "command",
    shell_command: "command",
    bash_command: "command",
    run: "command",
    input: "command",
    text: "command",
    shell: "command",
    line: "command",
    code: "command",
  },
  Glob: {
    pattern: "glob_pattern",
    glob: "glob_pattern",
    path: "target_directory",
    directory: "target_directory",
  },
  Grep: {
    query: "pattern",
    search: "pattern",
    regex: "pattern",
    path: "target_directory",
    directory: "target_directory",
  },
};

function card(value: unknown): HarnessCardV1 {
  return HarnessCardV1Schema.parse(value);
}

export const BUILTIN_HARNESS_CARDS: HarnessCardV1[] = [
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "generic-openai",
    display_name: "Generic OpenAI-compatible",
    model_match: {
      family_prefixes: ["generic", "openai-compatible"],
    },
    capabilities: {
      supports_thinking: true,
      native_tool_parser: true,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "qwen3-coder",
    display_name: "Qwen3 Coder",
    model_match: {
      family_prefixes: ["qwen3-coder"],
      model_substrings: ["qwen3-coder", "qwen-coder"],
      provider_hints: [],
    },
    capabilities: {
      supports_thinking: false,
      native_tool_parser: false,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
    repairs: {
      argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES,
      empty_arguments: "preserve",
      malformed_json: "conservative",
    },
    loop_controls: {
      repeated_tool_dampening: false,
      plan_no_action_limit: 2,
      edit_retry_limit: 2,
    },
    sampling_defaults: {
      temperature: 0.7,
      top_p: 0.95,
    },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "qwen3-coder-next",
    display_name: "Qwen3 Coder Next",
    model_match: { family_prefixes: ["qwen3-coder-next"], model_substrings: ["qwen3-coder-next"] },
    capabilities: { supports_thinking: false, native_tool_parser: true, strict_json: "medium", strict_tool_args: "medium" },
    sampling_defaults: { temperature: 1.0, top_p: 0.95 },
    repairs: { argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "qwen",
    display_name: "Qwen reasoning models",
    model_match: { family_prefixes: ["qwen"], model_substrings: ["qwen3.5", "qwen3.6", "qwen3-", "qwen3."] },
    capabilities: { supports_thinking: true, native_tool_parser: true, strict_json: "medium", strict_tool_args: "medium" },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "glm",
    display_name: "GLM",
    model_match: { family_prefixes: ["glm"], model_substrings: ["glm-4", "glm-5"] },
    capabilities: { supports_thinking: true, native_tool_parser: true, strict_json: "medium", strict_tool_args: "medium" },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "kimi",
    display_name: "Kimi / Moonshot",
    model_match: {
      family_prefixes: ["kimi", "moonshot"],
      model_substrings: ["kimi", "moonshot", "k2.5", "k2.6", "k2.7"],
      provider_hints: ["kimi_coding", "moonshot"],
    },
    capabilities: {
      supports_thinking: true,
      native_tool_parser: true,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
    repairs: {
      argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES,
      empty_arguments: "preserve",
      malformed_json: "conservative",
    },
    loop_controls: {
      repeated_tool_dampening: false,
      plan_no_action_limit: 2,
      edit_retry_limit: 2,
    },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "minimax",
    display_name: "MiniMax",
    model_match: {
      family_prefixes: ["minimax"],
      model_substrings: ["minimax", "abab"],
      provider_hints: ["minimax"],
    },
    capabilities: {
      supports_thinking: true,
      native_tool_parser: true,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
    repairs: {
      argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES,
      empty_arguments: "preserve",
      malformed_json: "conservative",
    },
    loop_controls: {
      repeated_tool_dampening: false,
      plan_no_action_limit: 3,
      edit_retry_limit: 2,
    },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "claude",
    display_name: "Claude",
    model_match: {
      family_prefixes: ["claude", "anthropic"],
      model_substrings: ["claude", "opus", "sonnet", "haiku"],
      provider_hints: ["anthropic"],
    },
    capabilities: {
      supports_thinking: true,
      native_tool_parser: true,
      strict_json: "high",
      strict_tool_args: "high",
    },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "deepseek",
    display_name: "DeepSeek",
    model_match: {
      family_prefixes: ["deepseek"],
      model_substrings: ["deepseek"],
      provider_hints: ["deepseek"],
    },
    capabilities: {
      supports_thinking: true,
      native_tool_parser: true,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
  }),
];

function normalize(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Specific model evidence outranks family hints; provider-only fallback must be unique. */
export function resolveHarnessCard(params: {
  modelId: string;
  provider?: string;
  family?: string;
  cards?: HarnessCardV1[];
}): HarnessCardV1 {
  const cards = params.cards?.length ? params.cards : BUILTIN_HARNESS_CARDS;
  const model = normalize(params.modelId);
  const family = normalize(params.family);
  const provider = normalize(params.provider);
  const exact = cards.find(c => c.model_match.exact_models.some(m => normalize(m) === model && model !== ""));
  if (exact) return exact;
  const bySpecificity = (kind: "model" | "family") => cards
    .map(card => ({ card, score: Math.max(0, ...(kind === "model" ? card.model_match.model_substrings : card.model_match.family_prefixes)
      .map(value => normalize(value))
      .filter(value => value && (kind === "model" ? model.includes(value) : family === value || family.startsWith(`${value}-`)))
      .map(value => value.length)) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.card;
  const matched = bySpecificity("model") ?? bySpecificity("family");
  if (matched) return matched;
  const providers = cards.filter(c => c.model_match.provider_hints.some(p => normalize(p) === provider && provider !== ""));
  return providers.length === 1 ? providers[0]! : BUILTIN_HARNESS_CARDS[0]!;
}
