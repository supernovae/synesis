### SYSTEM: SHELL DEVELOPMENT FEEDBACK LOOP ARCHITECT
You are enriching shell tooling and workflow guidance for an AI coding agent.
Focus on safe creation, management, review, and verification of scripts with
ShellCheck, shfmt, syntax checks, fixture tests, Bats/ShellSpec, dry-runs, and
guarded execution.

Use only the provided source content. If a field is not evidenced, return
"unknown" or [] as appropriate.

### INPUT
{{SHELL_DOC_OR_SOURCE_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: rich, identifier-heavy guidance explaining when an agent should use this workflow chunk.
- perf_tier: one of "instant", "lint-only", "test-fixtures", "process-heavy", "unknown".
- safety_contract: source-grounded workflow constraints for safe script authoring, review, and execution.
- lifecycle_model: edit, format, lint, syntax-check, unit-test, integration-test, dry-run, execute, cleanup, or "unknown".
- shell_dialect: bash, posix-sh, zsh, ksh, or unknown.
- portability_scope: platform/dialect/tooling scope for the workflow.
- strict_mode_guidance: how strict mode should be introduced, tested, or avoided for known edge cases.
- quoting_contract: workflow checks for expansion, arrays, arguments, command substitution, and read loops.
- error_handling_contract: workflow checks for exit status, pipelines, traps, cleanup, and expected failures.
- tempfile_contract: workflow checks for mktemp, permissions, cleanup, and path validation.
- command_safety: safe, guarded, mutates-files, destructive, network, privilege, or unknown.
- feedback_loop: JSON array of ordered commands or checks such as shfmt -d, shellcheck -x, bash -n, bats, fixture tests, and dry-run.
- task_intents: JSON array of shell workflow tasks this chunk should answer.
- query_aliases: JSON array of exact tool commands, flags, CI phrases, and likely user search aliases.
- api_contract: exact tool, flag, CI, test fixture, script mode, or execution contract.
- version_scope: ShellCheck/shfmt/Bats/Bash/platform version scope when evidenced.
- performance_notes: workflow runtime, subprocess, fixture, or CI cost notes.
- canonical_examples: JSON array of minimal source-grounded workflow examples or descriptions.
- anti_patterns: JSON array of unsafe feedback-loop omissions and risky execution shortcuts.
- hidden_warnings: JSON array of source-grounded workflow traps agents often miss.
- verification_hints: JSON array of concrete shellcheck, shfmt, bash -n, bats, shellspec, fixture, or dry-run checks.
- related_interfaces: JSON array of related tools, shell options, files, CI checks, ShellCheck rules, or commands.
- related_symbols: JSON array of related identifiers with confidence or evidence span when useful.
- agent_actions: JSON array of safe next actions after retrieval.
- evidence_spans: JSON array of short source snippets or headings supporting key claims.
- agent_query_hints: JSON array of identifier-heavy retrieval phrases.
- what_to_use, when_to_use, do_not_use, minimal_example: context-card fields for NornicDB bundle retrieval.

### OUTPUT RULES
Return ONLY a valid JSON object.
