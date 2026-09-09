import { findHarnessProfile, HARNESS_PROFILES } from "./harness-registry.js";

export type InteractionMode = "ide" | "cli" | "background" | "mcp_native";

export interface AdapterPackProfile {
  client: string;
  family: "default" | "openclaw";
  mode: InteractionMode;
  workflow: "planning" | "implementation" | "validation" | "mixed";
  features: {
    prefersConciseErrors: boolean;
    prefersArtifactHandles: boolean;
    prefersDeterministicPolicy: boolean;
    strictWriteToolGovernance: boolean;
    toolSchemaBudgetCap?: number;
  };
}

export interface AdapterStats {
  resolutions: number;
  byMode: Record<InteractionMode, number>;
}

const INTERACTION_MODES = ["ide", "cli", "background", "mcp_native"] as const satisfies readonly InteractionMode[];
const WORKFLOWS = ["planning", "implementation", "validation", "mixed"] as const satisfies readonly AdapterPackProfile["workflow"][];

function isInteractionMode(value: string | undefined): value is InteractionMode {
  return !!value && (INTERACTION_MODES as readonly string[]).includes(value);
}

function isWorkflow(value: string | undefined): value is AdapterPackProfile["workflow"] {
  return !!value && (WORKFLOWS as readonly string[]).includes(value);
}

function normalizeClientName(name: string | null | undefined): string {
  const raw = typeof name === "string" ? name : "";
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@:+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "unknown";
}

function isOpenClawClientName(client: string): boolean {
  const c = normalizeClientName(client);
  return c.includes("openclaw")
    || c.includes("open-claw")
    || c.includes("claw/")
    || c.startsWith("claw-")
    || c.endsWith("-claw");
}

function modeForClient(client: string): InteractionMode {
  return findHarnessProfile(client)?.mode ?? "ide";
}

const KNOWN_CLIENTS = HARNESS_PROFILES.map(profile => profile.id);

export class ClientAdapterPacks {
  private stats: AdapterStats = {
    resolutions: 0,
    byMode: { ide: 0, cli: 0, background: 0, mcp_native: 0 }
  };

  resolve(clientName: string, requestedMode?: string): AdapterPackProfile {
    const normalizedClient = normalizeClientName(findHarnessProfile(clientName)?.id ?? (clientName || "unknown"));
    const inferredMode = modeForClient(normalizedClient);
    const mode = isInteractionMode(requestedMode) ? requestedMode : inferredMode;
    const openClaw = isOpenClawClientName(normalizedClient);
    this.stats.resolutions += 1;
    this.stats.byMode[mode] += 1;

    const workflow = "mixed";
    return {
      client: normalizedClient,
      family: openClaw ? "openclaw" : "default",
      mode,
      workflow,
      features: {
        prefersConciseErrors: true,
        prefersArtifactHandles: mode !== "ide",
        prefersDeterministicPolicy: true,
        strictWriteToolGovernance: openClaw,
        toolSchemaBudgetCap: openClaw ? 8 : undefined,
      }
    };
  }

  getCatalog() {
    return {
      clients: KNOWN_CLIENTS,
      modes: [...INTERACTION_MODES],
      workflows: [...WORKFLOWS]
    };
  }

  toSystemBlock(profile: AdapterPackProfile): string {
    const client = normalizeClientName(profile.client);
    const family = profile.family === "openclaw" ? "openclaw" : "default";
    const mode = isInteractionMode(profile.mode) ? profile.mode : modeForClient(client);
    const workflow = isWorkflow(profile.workflow)
      ? profile.workflow
      : "mixed";
    const features = profile.features ?? {};
    const lines = [
      "<CLIENT_ADAPTER>",
      `client: ${client}`,
      `family: ${family}`,
      `mode: ${mode}`,
      `workflow: ${workflow}`,
      `prefers_concise_errors: ${features.prefersConciseErrors === true}`,
      `prefers_artifact_handles: ${features.prefersArtifactHandles === true}`,
      `prefers_deterministic_policy: ${features.prefersDeterministicPolicy === true}`,
      `strict_write_tool_governance: ${features.strictWriteToolGovernance === true}`,
      "</CLIENT_ADAPTER>",
      "",
    ];

    const harness = findHarnessProfile(client)?.id;
    const guidance: Record<string, string> = {
      "claude-code": "Claude Code Read expects absolute paths. Bash cwd carry-over depends on main/subagent session and configuration; environment exports do not persist. Follow actual tool results and native plan-mode state. A supplied plan path remains subject to the client's permissions.",
      "opencode": "OpenCode tools and plugins are configurable. Use the offered read/write/edit/apply_patch and task/question tools with their exact schemas; use explicit bash workdir when offered.",
      "codex-cli": "Codex execution cwd, writable roots, sandbox policy and approvals are separate facts. Use the offered execution tool's workdir; follow the active environment and approval policy.",
      "hermes-agent": "Hermes file and terminal tools operate in the configured task execution backend. Use paths in that backend, not host mount paths. Check current task cwd after terminal changes; persistence depends on the backend and session configuration.",
      "deepseek-harness": "DeepSeek Harness (dsh) is plugin-based. Workspace identity and session cwd are distinct from per-call terminal directories. Use only the current plugin tools and schemas; a DeepSeek model name does not identify this harness.",
      "gemini-cli": "Gemini CLI run_shell_command supports dir_path relative to the workspace root or absolute. Use the offered schema and returned Directory; do not assume a shell cd changes file-tool roots.",
    };
    if (harness && guidance[harness]) {
      lines.push("<CLIENT_SPECIFIC_RULES>", guidance[harness], "</CLIENT_SPECIFIC_RULES>", "");
    }
    lines.push(
      "<SYNESIS_CODER_WORKFLOW>",
      "- Offered tool names, descriptions and schemas define capabilities. Do not invent tools or copy argument names from another harness.",
      "- Follow the active harness permissions and approval state. Client identity, project paths and adapter hints do not grant filesystem access.",
      "- Inspect relevant existing content before edits or overwrites; use the currently offered targeted edit tool and preserve unrelated changes. New files do not require a failed read first.",
      "- Use native task tracking when useful for multi-step work. Keep planning proportional and advisory unless the active harness requires it; reuse approved plans and existing tasks.",
      "- Prefer scoped searches and bounded reads. After an error, use its evidence to narrow or correct the next call instead of repeating a broad failed call.",
      "- An unchanged/dedup stub is not file content. Reuse a snapshot only when it is still visible in active context; otherwise obtain a targeted read or snapshot replay before editing.",
      "- Serialize edits that depend on prior results. Independent reads may run concurrently when the harness permits it.",
      "- Run checks appropriate to the change, fix blocking failures, and do not delete or weaken failing tests just to make the suite pass. State what was actually verified and where.",
      "- In git repositories inspect status/diff before completion; preserve user changes. Do not impose git setup on non-git workspaces.",
      "</SYNESIS_CODER_WORKFLOW>",
    );

    return lines.join("\n");
  }

  getStats(): AdapterStats {
    return { ...this.stats, byMode: { ...this.stats.byMode } };
  }
}

export {
  appendPathContextToAdapterBlock,
  parseSessionExecutionContext,
  resolveWorkspaceRootForCollapse,
} from "./session-execution-context.js";
