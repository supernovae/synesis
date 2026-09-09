# Harness compatibility review

Reviewed 2026-09-09. This is compatibility support in Yarn's model API proxy and ACP bridge. It does not install or launch the named clients. Tests exercise the transport, adapter, schema restoration and path contracts; they are not live end-to-end certification of every upstream release.

Model-family adaptations are reviewed separately in the [model shim audit](../model-shim-audit-2026-09.md). A DeepSeek model is not evidence that the caller is DeepSeek Harness.

## Integration contract

Use `x-synesis-client` or flat `metadata.synesis_client` with one of the client IDs below. Send the existing `synesis_project_root` and `synesis_shell_cwd` metadata (or equivalent headers) from the **execution environment**, not the proxy or the browser. Use distinct conversation/session IDs for concurrent workspaces. Refresh cwd after changes, and refresh workspace context when moving to another checkout or backend.

```json
{
  "synesis_client": "hermes-agent",
  "synesis_project_root": "/workspace/project",
  "synesis_shell_cwd": "/workspace/project/packages/api"
}
```

For DeepSeek Harness use `deepseek-harness`. `dsh` and `@deepseek-ai/dsh` are recognized aliases. For Hermes, `hermes` is also accepted. Header identity takes priority over metadata, then identifiable user-agent tokens. Generic Anthropic/OpenAI SDKs and a DeepSeek model name do not establish harness identity. The Messages endpoint retains its legacy Claude Code fallback when no client identity is supplied; non-Claude clients should identify themselves explicitly.

No stock client is assumed to emit Synesis-specific fields. Configure them through its provider integration or a deployment-owned bridge. Omit unknown facts rather than invent them. HTTP metadata is advisory context; only trusted deployment configuration may grant access.

## Upstream behavior and corresponding handling

| Harness | Checked behavior | Yarn handling |
|---|---|---|
| Claude Code | Read expects absolute paths. Main-session Bash cwd can persist within permitted directories; subagents and configuration differ. Exports do not persist. | Preserve absolute paths, defer plan state and permissions to the client, avoid universal cwd claims. |
| Codex CLI | Execution directories, writable roots and approvals are separate controls. | Recognize `codex-cli`/`codex`; follow offered execution tool schema and active policy. |
| OpenCode | Built-in and custom tools are configurable; custom tools have directory/worktree context. | Preserve offered names and schema, including camelCase arguments; no mandatory tool roster. |
| Hermes Agent | File operations use the task's configured terminal environment, including remote/container backends and task cwd tracking. | Recognize `hermes-agent`/`hermes`, restore native `path`/`cmd` keys when advertised, preserve execution-backend paths. |
| DeepSeek Harness | Plugin-based developer preview; workspace identity uses canonical paths, session header cwd is distinct from workspace membership. | Recognize `deepseek-harness`/`dsh`; use current plugin schemas and explicit session facts. No invented stable tool roster or tool names derived from the model. |
| Gemini CLI | `run_shell_command.dir_path` accepts workspace-relative or absolute paths; results report Directory. | Recognize CLI mode and shell safety alias; preserve per-call directory and offered schema. |
| Pi, Goose, Aider | Additional recognized coding clients; no verified universal native tool contract asserted here. | Shared schema-driven guidance, path fallback and fresh-session isolation. Explicit mode overrides remain available. |
| Cursor, Cline/Roo, Continue, Windsurf, Copilot, Junie, Zed/JetBrains | IDE tool surfaces may vary by version and configuration. | Shared capability guidance; no hardcoded screenshot/edit tool requirement. |

Sources checked:

- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [Codex security](https://learn.chatgpt.com/docs/security)
- [OpenCode custom tools](https://opencode.ai/docs/custom-tools/)
- [Hermes file tools source](https://github.com/NousResearch/hermes-agent/blob/main/tools/file_tools.py) and [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [workspace contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workspace.md), [terminal subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/terminal.md)
- [Gemini shell tool](https://geminicli.com/docs/tools/shell/)

These are moving upstream references, not version pins. Recheck them when adapting a new client release. DeepSeek explicitly warns of preview compatibility breaks.

## Layers reviewed and changes

- **Client identity and adapters:** one registry feeds mode inference, coder-session detection, user-agent identification and missing-path guidance. CLI no longer means “validation workflow”; background no longer means “planning workflow.” Explicit caller mode wins. Client identity does not advertise tool availability.
- **Model behavior shims:** retain model/protocol adaptations but remove claims that model family determines native path roots. Remove the short-source-file heuristic that replaced Write with Bash; short code is valid, and changing tools changes permissions and cwd semantics.
- **Schema restoration:** exact offered name wins over canonical aliases, ambiguous alias matches do not choose the first tool, and Responses-style parameter schemas are recognized. Native `path`, `cmd` and camelCase keys are restored using the actual schema.
- **Path governance and ACP:** preserve the intended target, including Windows drives, Linux homes, POSIX backslashes and repeated directory names. Missing ACP relative-path context is an error. Lexical path comparison uses client path syntax rather than the proxy's OS.
- **Sandbox:** remove server-home/temp assumptions, blanket harness configuration access and plan-path exceptions. Explicit deny rules win. See [migration details](SESSION_EXECUTION_CONTEXT.md#harness-compatibility-and-migration-september-2026).
- **Context and snapshots:** remove the claim that dedup stubs prove the content remains visible. Keep the existing snapshot registry/replay and targeted-read recovery. Open/recent files do not prove workspace ownership.
- **Upper-harness safety:** extend known shell/write/path-field aliases for native tools. These checks are defense in depth, not an execution sandbox or a guarantee about unknown plugins.

## Research adoption

[SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793) evaluates how interface design affects software-agent performance. We apply its interface-design direction conservatively: bounded discovery, concise actionable errors, and the actual tool contract. It does not establish a universal cwd or permission policy.

[Context as a Tool: Context Management for Long-Horizon SWE-Agents](https://arxiv.org/abs/2512.22087) studies explicit context management for longer tasks. The relevant design inference here is to distinguish available source content from a memory/dedup reference. We retain the existing explicit snapshot lifecycle and remove contradictory prompt text; we do not claim to reproduce the paper's method or benchmark gains.

No new planner, multi-agent subsystem, context store or plugin framework is introduced solely because a paper uses one. Such additions would need measured improvements on this repository's harness evaluations.

## Remaining operational limits

The proxy cannot observe arbitrary native `cd`, resolve a remote symlink, inspect all plugin implementations, or infer writable roots from a client name. Shell command scanning cannot replace the native sandbox. Metadata freshness and explicit conversation identity remain bridge responsibilities. The registry adds compatibility routing and conservative defaults; validate actual upstream payloads and execution behavior in a staged client session before rollout.
