/**
 * Composition intent detector — heuristic detection of code generation
 * and scaffolding tasks to trigger pattern library prefetch.
 *
 * Returns null when no composition intent is detected, allowing the
 * normal error/constraint evidence pipeline to handle the request.
 */
import { getLanguagePackRegistry } from "../language-packs/index.js";
const COMPOSITION_VERBS = /\b(?:create|write|build|implement|scaffold|add\s+a|set\s+up|generate|make\s+a|define)\b/i;
const SKILL_KEYWORDS = [
    { pattern: /\b(?:endpoint|route|handler|api|controller|resource)\b/i, family: "api_endpoint" },
    { pattern: /\b(?:test|spec|describe|it\s*\(|expect|assert|xunit|junit|pytest)\b/i, family: "test_scaffold" },
    { pattern: /\b(?:error\s+handling|exception|try.?catch|result\s+type|sentinel)\b/i, family: "error_handling" },
    { pattern: /\b(?:schema|model|struct|class|record|dataclass|interface|type\s+def)\b/i, family: "data_structure" },
    { pattern: /\b(?:config|configuration|settings|env\s+var|feature\s+flag)\b/i, family: "config_pattern" },
    { pattern: /\b(?:async|concurrent|parallel|goroutine|channel|promise|future|spawn)\b/i, family: "async_pattern" },
    { pattern: /\b(?:auth|jwt|oauth|bearer|api\s+key|middleware\s+auth)\b/i, family: "auth_pattern" },
    { pattern: /\b(?:log|logging|logger|structured\s+log|tracing)\b/i, family: "logging_pattern" },
    { pattern: /\b(?:validat|sanitiz|constraint|check\s+input)\b/i, family: "validation_pattern" },
    { pattern: /\b(?:migrat|alter\s+table|add\s+column)\b/i, family: "migration_pattern" },
];
const LANGUAGE_KEYWORDS = [
    { pattern: /\b(?:typescript|ts|tsx|node\.?js)\b/i, language: "typescript" },
    { pattern: /\b(?:python|py|django|flask|fastapi)\b/i, language: "python" },
    { pattern: /\b(?:golang|go\b(?:\s+(?:http|func|struct))?)/i, language: "go" },
    { pattern: /\b(?:rust|cargo|tokio|axum|actix)\b/i, language: "rust" },
    { pattern: /\b(?:java\b(?!script)|spring|maven|gradle|jvm)\b/i, language: "java" },
    { pattern: /\b(?:c#|csharp|\.net|asp\.net|dotnet)\b/i, language: "csharp" },
    { pattern: /\b(?:sql|postgres|mysql|sqlite|query)\b/i, language: "sql" },
    { pattern: /\b(?:bash|shell|sh\b|zsh|shellcheck)\b/i, language: "bash" },
    { pattern: /\b(?:terraform|hcl|tf\b|tofu)\b/i, language: "terraform" },
    { pattern: /\b(?:kubernetes|k8s|helm|kubectl|yaml\s+manifest)\b/i, language: "yaml-k8s" },
];
const USEFUL_PHASES = new Set(["implement", "plan", "execute"]);
function detectLanguage(text) {
    for (const { pattern, language } of LANGUAGE_KEYWORDS) {
        if (pattern.test(text))
            return language;
    }
    const registry = getLanguagePackRegistry();
    for (const pack of registry.getAllPacks()) {
        const langRe = new RegExp(`\\b${pack.language}\\b`, "i");
        if (langRe.test(text))
            return pack.language;
    }
    return null;
}
function detectSkillFamily(text) {
    for (const { pattern, family } of SKILL_KEYWORDS) {
        if (pattern.test(text))
            return family;
    }
    return "api_endpoint";
}
/**
 * Detect whether the user prompt describes a code composition task.
 * Returns null for questions, error reports, or non-generation prompts.
 */
export function detectCompositionIntent(userText, workingPhase) {
    if (workingPhase && !USEFUL_PHASES.has(workingPhase)) {
        return null;
    }
    if (!COMPOSITION_VERBS.test(userText)) {
        return null;
    }
    if (/\b(?:fix|debug|error\b(?!\s+handling)|bug|why\s+(?:is|does|doesn't)|explain|what\s+is)\b/i.test(userText)) {
        return null;
    }
    const language = detectLanguage(userText);
    if (!language)
        return null;
    const skillFamily = detectSkillFamily(userText);
    let confidence = 0.5;
    if (workingPhase === "implement")
        confidence += 0.15;
    if (COMPOSITION_VERBS.test(userText))
        confidence += 0.1;
    if (language)
        confidence += 0.1;
    const searchQuery = `${language} ${skillFamily} idiomatic pattern ${userText.slice(0, 100)}`.trim();
    return {
        language,
        skillFamily,
        searchQuery,
        confidence: Math.min(confidence, 1.0),
    };
}
