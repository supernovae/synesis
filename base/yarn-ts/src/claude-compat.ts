import {
  resolveExplicitTierFromRequestedModel,
  type EffortTier,
  type ResolvedExplicitTierReason,
} from "./orchestration/phase-model-orchestrator.js";
import type { ClaudeBootstrapPreset } from "./schemas.js";

export interface ClaudeBootstrapTemplate {
  templateId: string;
  version: string;
  path: "CLAUDE.md";
  preset: ClaudeBootstrapPreset;
  content: string;
  notes: string[];
}

export interface ClaudeModelResolution {
  requestedModel: string;
  resolvedTier: EffortTier | null;
  resolutionReason: ResolvedExplicitTierReason | "none";
}

export interface ClaudeCommandExecution {
  command: string;
  supported: boolean;
  clientLocal: boolean;
  action: string;
  notes: string[];
  data?: Record<string, unknown>;
}

const BASELINE_CLAUDE_MD = `# CLAUDE.md

Work narrowly and cheaply.

- Do not scan the full repo unless required.
- Search first, then open only relevant files.
- Fix one package or one failing target at a time.
- Make minimal edits.
- Prefer patches over rewrites.
- Run gofmt on changed Go files.
- Run the narrowest relevant go test command first.
- Summarize logs; do not keep large outputs in context.
- Avoid unrelated refactors or dependency changes.
- After each step, report:
  - target
  - root cause
  - files changed
  - validation result
  - next smallest step`;

const PRESET_SUFFIX: Record<Exclude<ClaudeBootstrapPreset, "default">, string> = {
  "go-strict": "\n\nGo preset addendum:\n- Keep changes package-scoped.\n- Prefer targeted `go test ./path -run <name>` before broader test sweeps.",
  "ts-strict": "\n\nTypeScript preset addendum:\n- Run `npm run typecheck` only for touched workspace/package first.\n- Prefer narrowly scoped Vitest targets before full test suites.",
  "python-strict": "\n\nPython preset addendum:\n- Use `uv run` for lint/test commands where available.\n- Start with module-level tests before broader runs.",
};

export function buildClaudeBootstrapTemplate(preset: ClaudeBootstrapPreset): ClaudeBootstrapTemplate {
  const content = preset === "default" ? BASELINE_CLAUDE_MD : `${BASELINE_CLAUDE_MD}${PRESET_SUFFIX[preset]}`;
  return {
    templateId: `synesis-claude-${preset}`,
    version: "2026-04-06.1",
    path: "CLAUDE.md",
    preset,
    content,
    notes: [
      "Claude slash commands are client-local; this endpoint returns Synesis API-equivalent bootstrap content.",
      "Write the content to CLAUDE.md at your project root in your client workflow.",
    ],
  };
}

export function resolveClaudeModelSelection(
  requestedModel: string,
  tierMap: Record<string, EffortTier>,
): ClaudeModelResolution {
  const resolved = resolveExplicitTierFromRequestedModel(requestedModel, tierMap);
  return {
    requestedModel,
    resolvedTier: resolved?.tier ?? null,
    resolutionReason: resolved?.reason ?? "none",
  };
}

export interface ClaudeCommandContext {
  tierMap: Record<string, EffortTier>;
  availableModels: string[];
  command: string;
  model?: string;
  conversationId?: string;
  sessionKey?: string;
  currentWorkPacket?: Record<string, unknown> | null;
}

export function executeClaudeCompatCommand(ctx: ClaudeCommandContext): ClaudeCommandExecution {
  const normalized = ctx.command.trim().toLowerCase();
  if (normalized === "init") {
    const template = buildClaudeBootstrapTemplate("default");
    return {
      command: normalized,
      supported: true,
      clientLocal: false,
      action: "return_bootstrap_template",
      notes: [
        "Use this payload as the source for creating CLAUDE.md in your client or tooling.",
        "Create CLAUDE.md only when it does not already exist, or merge/review with the user before replacing existing guidance.",
      ],
      data: {
        template,
        writePolicy: {
          path: "CLAUDE.md",
          mode: "create_only",
          existingFileAction: "review_or_merge_do_not_overwrite_without_explicit_user_confirmation",
          emptyWorkspaceAction: "safe_to_offer_create_at_workspace_root",
        },
      },
    };
  }

  if (normalized === "model") {
    const requested = (ctx.model ?? "").trim();
    const resolution = requested
      ? resolveClaudeModelSelection(requested, ctx.tierMap)
      : { requestedModel: "", resolvedTier: null, resolutionReason: "none" as const };
    return {
      command: normalized,
      supported: true,
      clientLocal: false,
      action: "model_resolution",
      notes: ["When `model` is omitted, this command only returns discoverable tier IDs."],
      data: {
        availableModels: ctx.availableModels,
        resolution,
      },
    };
  }

  if (normalized === "compact") {
    return {
      command: normalized,
      supported: true,
      clientLocal: false,
      action: "session_compaction_requested",
      notes: [
        "Compacting session context now.",
        "mode: synesis_session_compaction",
        "Compaction is applied to Synesis session state; this is not Anthropic client-side transcript compaction.",
      ],
      data: {
        mode: "synesis_session_compaction",
        conversationId: ctx.conversationId ?? "",
        sessionKey: ctx.sessionKey ?? "",
      },
    };
  }

  if (["memory", "show_memory", "current_work_packet", "work_packet"].includes(normalized)) {
    return {
      command: normalized,
      supported: true,
      clientLocal: false,
      action: "current_work_packet",
      notes: [
        "Returns the latest Synesis durable work packet for this session.",
        "This is model-facing upper-harness state; it does not mutate model internals or local files.",
      ],
      data: {
        mode: "synesis_current_work_packet",
        conversationId: ctx.conversationId ?? "",
        sessionKey: ctx.sessionKey ?? "",
        currentWorkPacket: ctx.currentWorkPacket ?? null,
      },
    };
  }

  if (["clear_memory", "clear_work_packet", "reset_memory"].includes(normalized)) {
    return {
      command: normalized,
      supported: true,
      clientLocal: false,
      action: "current_work_packet_clear_requested",
      notes: [
        "Clears the persisted Synesis durable work packet for this session.",
        "Future requests can rebuild a new packet from fresh session events and tool truth.",
      ],
      data: {
        mode: "synesis_current_work_packet_clear",
        conversationId: ctx.conversationId ?? "",
        sessionKey: ctx.sessionKey ?? "",
      },
    };
  }

  const commonlyClientLocal = new Set([
    "config",
    "doctor",
    "help",
    "login",
    "logout",
    "permissions",
    "review",
    "status",
    "vim",
  ]);
  return {
    command: normalized,
    supported: false,
    clientLocal: commonlyClientLocal.has(normalized),
    action: "unsupported_command",
    notes: [
      "This slash command is not implemented as a Synesis API action.",
      "Unknown or client-local commands should be handled by the CLI client UX.",
    ],
  };
}
