import { classifyErrorFamily } from "../../validation/enrichment.js";
export const bashPack = {
    id: "lang-bash",
    language: "bash",
    displayName: "Bash / Shell",
    version: "1.0.0",
    families: ["shellcheck"],
    toolSignals: [
        { pattern: /\bshellcheck\b/i, family: "shellcheck" },
    ],
    classifiers: {
        shellcheck: (msg, ruleId) => classifyErrorFamily("shellcheck", msg, ruleId),
    },
    reducerFamilies: ["shellcheck"],
    fastPathPatterns: [
        {
            name: "shellcheck_rule",
            regex: /\bSC(\d{4})\b/,
            scope_tags: ["linter-rules"],
            constraint_kind: "guiding",
            queryTransform: (m) => `ShellCheck rule SC${m[1]}`,
        },
        {
            name: "bash_syntax_error",
            regex: /\bsyntax error\b.*?(?:unexpected|near)\s+[`'"](.*?)[`'"]/i,
            scope_tags: ["error-catalog"],
            constraint_kind: "hard",
            queryTransform: (m) => `Bash syntax error near "${m[1]}"`,
        },
    ],
    verificationCommands: [
        { tool: "shellcheck", command: "shellcheck -x *.sh", description: "Lint shell scripts" },
        { tool: "bash-syntax", command: "bash -n script.sh", description: "Check shell syntax" },
    ],
    fixRecipes: [
        {
            errorFamily: "unquoted_variable",
            template: "Wrap the variable expansion in double quotes: \"$var\" in {file}.",
            description: "Variable expansion not quoted — risks word splitting and globbing",
        },
        {
            errorFamily: "missing_cd_check",
            template: "Add `|| exit` after `cd` to handle directory change failures in {file}.",
            description: "cd command used without checking its exit status",
        },
        {
            errorFamily: "deprecated_syntax",
            template: "Replace with the modern syntax suggested by ShellCheck.",
            description: "Deprecated Bash/POSIX syntax used",
        },
        {
            errorFamily: "unused_variable",
            template: "Remove the unused assignment, use the variable, or prefix with _ for intentional discard in {file}.",
            description: "Variable assigned but never referenced.",
            steps: [
                "Remove unused variable or use it",
                "Prefix with _ for intentional",
                "Check for typos",
            ],
            constraints: "Use _ prefix convention.",
        },
        {
            errorFamily: "unquoted_expansion",
            template: "Quote command substitution with double quotes or use arrays for safe iteration in {file}.",
            description: "Command substitution not quoted, risking word splitting.",
            steps: [
                "Quote the expansion with double quotes",
                "Use arrays for word-split-safe iteration",
            ],
            constraints: "Always quote expansions.",
        },
        {
            errorFamily: "declare_assign",
            template: "Split `declare` and assignment into separate lines so exit codes are visible in {file}.",
            description: "Declaration and assignment combined masks exit code.",
            steps: ["Separate declare and assignment into two lines"],
            constraints: "Always check exit codes.",
        },
        {
            errorFamily: "indirect_exit_code",
            template: "Put the command directly in if/while or capture $? immediately after the command in {file}.",
            description: "Checking $? instead of using command directly in if.",
            steps: [
                "Put command directly in if/while condition",
                "Or capture exit code immediately",
            ],
            constraints: "Prefer direct command in if.",
        },
        {
            errorFamily: "missing_read_r",
            template: "Use `read -r` and set IFS= when you need a full line without mangling backslashes in {file}.",
            description: "read without -r mangles backslashes.",
            steps: [
                "Add -r flag to read",
                "Use IFS= for full line reading",
            ],
            constraints: "Always use read -r.",
        },
    ],
    corpusPackId: "lang-bash",
};
