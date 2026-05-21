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
      supports_thinking: false,
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
      family_prefixes: ["qwen", "qwen3"],
      model_substrings: ["qwen3-coder", "qwen-coder"],
      provider_hints: ["dashscope", "vllm", "openrouter"],
    },
    capabilities: {
      supports_thinking: false,
      native_tool_parser: false,
      max_effective_tools: 40,
      strict_json: "low",
      strict_tool_args: "low",
    },
    repairs: {
      argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES,
      empty_arguments: "normalize_to_empty_object",
      malformed_json: "conservative",
    },
    loop_controls: {
      repeated_tool_dampening: true,
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
    id: "kimi",
    display_name: "Kimi / Moonshot",
    model_match: {
      family_prefixes: ["kimi", "moonshot"],
      model_substrings: ["kimi", "moonshot", "k2.5", "k2.6"],
      provider_hints: ["kimi_coding", "moonshot", "openrouter", "vllm"],
    },
    capabilities: {
      supports_thinking: true,
      native_tool_parser: true,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
    repairs: {
      argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES,
      empty_arguments: "normalize_to_empty_object",
      malformed_json: "conservative",
    },
    loop_controls: {
      repeated_tool_dampening: true,
      plan_no_action_limit: 2,
      edit_retry_limit: 2,
    },
    sampling_defaults: {
      temperature: 1,
      top_p: 0.95,
    },
  }),
  card({
    schema_version: HARNESS_CARD_SCHEMA_VERSION,
    id: "minimax",
    display_name: "MiniMax",
    model_match: {
      family_prefixes: ["minimax"],
      model_substrings: ["minimax", "abab"],
      provider_hints: ["minimax", "openrouter"],
    },
    capabilities: {
      supports_thinking: false,
      native_tool_parser: true,
      strict_json: "medium",
      strict_tool_args: "medium",
    },
    repairs: {
      argument_aliases: COMMON_CODING_TOOL_ARGUMENT_ALIASES,
      empty_arguments: "normalize_to_empty_object",
      malformed_json: "conservative",
    },
    loop_controls: {
      repeated_tool_dampening: true,
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
      provider_hints: ["deepseek", "vllm", "openrouter"],
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

function cardMatches(cardValue: HarnessCardV1, modelId: string, provider?: string, family?: string): boolean {
  const model = normalize(modelId);
  const providerHint = normalize(provider);
  const familyHint = normalize(family);
  const match = cardValue.model_match;
  if (match.exact_models.some((m) => normalize(m) === model)) return true;
  if (match.model_substrings.some((m) => model.includes(normalize(m)))) return true;
  if (familyHint && match.family_prefixes.some((m) => familyHint.startsWith(normalize(m)))) return true;
  if (providerHint && match.provider_hints.some((m) => providerHint.includes(normalize(m)))) return true;
  return false;
}

export function resolveHarnessCard(params: {
  modelId: string;
  provider?: string;
  family?: string;
  cards?: HarnessCardV1[];
}): HarnessCardV1 {
  const cards = params.cards?.length ? params.cards : BUILTIN_HARNESS_CARDS;
  return cards.find((candidate) =>
    cardMatches(candidate, params.modelId, params.provider, params.family),
  ) ?? BUILTIN_HARNESS_CARDS[0]!;
}
