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

function normalizeClientName(name: string): string {
  return name.trim().toLowerCase();
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
  const c = normalizeClientName(client);
  if (c.includes("codex") || c.includes("cli")) return "cli";
  if (c.includes("copilot-agent") || c.includes("background") || c.includes("pr")) return "background";
  if (c.includes("mcp")) return "mcp_native";
  return "ide";
}

const KNOWN_CLIENTS = [
  "claude-code",
  "openclaw",
  "openclaw-derivative",
  "cursor",
  "vscode-copilot",
  "windsurf",
  "junie",
  "continue",
  "roo",
  "cline",
  "codex-cli",
];

export class ClientAdapterPacks {
  private stats: AdapterStats = {
    resolutions: 0,
    byMode: { ide: 0, cli: 0, background: 0, mcp_native: 0 }
  };

  resolve(clientName: string, requestedMode?: string): AdapterPackProfile {
    const normalizedClient = normalizeClientName(clientName || "unknown");
    const mode = (requestedMode as InteractionMode) || modeForClient(normalizedClient);
    const openClaw = isOpenClawClientName(normalizedClient);
    this.stats.resolutions += 1;
    this.stats.byMode[mode] += 1;

    const workflow = mode === "background" ? "planning" : mode === "cli" ? "validation" : "mixed";
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
      modes: ["ide", "cli", "background", "mcp_native"] as InteractionMode[],
      workflows: ["planning", "implementation", "validation", "mixed"]
    };
  }

  toSystemBlock(profile: AdapterPackProfile): string {
    return [
      "<CLIENT_ADAPTER>",
      `client=${profile.client}`,
      `family=${profile.family}`,
      `mode=${profile.mode}`,
      `workflow=${profile.workflow}`,
      `prefers_concise_errors=${profile.features.prefersConciseErrors}`,
      `prefers_artifact_handles=${profile.features.prefersArtifactHandles}`,
      `prefers_deterministic_policy=${profile.features.prefersDeterministicPolicy}`,
      `strict_write_tool_governance=${profile.features.strictWriteToolGovernance}`,
      "</CLIENT_ADAPTER>",
      "",
      "<SYNESIS_CODER_WORKFLOW>",
      "phase_order=explore|contract|implement|verify_fast|verify_deep",
      "- Prefer search_code or synesis_inspect_repo to locate files/symbols, then read_file (optionally startLine/endLine) — avoid huge undirected reads.",
      "- Never edit a file before inspecting it. Search first unless the user already gave exact file and region.",
      "- Prefer apply_patch for existing files; use write_file for new/generated files or when patching is infeasible after inspection.",
      "- After patch mismatch, read the smallest nearby window and retry with adjusted context instead of blind retries.",
      "- For Synesis platform APIs, deployment, and conventions: synesis_search / synesis_docs_search before guessing.",
      "- Ambiguous or multi-step tasks: synesis_classify then synesis_plan before large edits.",
      "- Verify: run_lint and run_build (verify_fast) before run_test when compile/typecheck applies; fix errorLines/summary from run_* before rerunning.",
      "- Prefer minimal patches, but do not be minimal in quality: if formatting/lint/typecheck/test fails, continue repair until blocking failures are gone.",
      "- Do not claim completion while blocking quality checks remain; report not-complete with next actions instead.",
      "- External APIs, money, or compliance: state unknowns and explicit acceptance checks (commands/tests) before implementation.",
      "</SYNESIS_CODER_WORKFLOW>",
    ].join("\n");
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
