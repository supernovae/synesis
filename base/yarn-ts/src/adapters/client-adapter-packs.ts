export type InteractionMode = "ide" | "cli" | "background" | "mcp_native";

export interface AdapterPackProfile {
  client: string;
  mode: InteractionMode;
  workflow: "planning" | "implementation" | "validation" | "mixed";
  features: {
    prefersConciseErrors: boolean;
    prefersArtifactHandles: boolean;
    prefersDeterministicPolicy: boolean;
  };
}

export interface AdapterStats {
  resolutions: number;
  byMode: Record<InteractionMode, number>;
}

function normalizeClientName(name: string): string {
  return name.trim().toLowerCase();
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
    this.stats.resolutions += 1;
    this.stats.byMode[mode] += 1;

    const workflow = mode === "background" ? "planning" : mode === "cli" ? "validation" : "mixed";
    return {
      client: normalizedClient,
      mode,
      workflow,
      features: {
        prefersConciseErrors: true,
        prefersArtifactHandles: mode !== "ide",
        prefersDeterministicPolicy: true
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
      `mode=${profile.mode}`,
      `workflow=${profile.workflow}`,
      `prefers_concise_errors=${profile.features.prefersConciseErrors}`,
      `prefers_artifact_handles=${profile.features.prefersArtifactHandles}`,
      `prefers_deterministic_policy=${profile.features.prefersDeterministicPolicy}`,
      "</CLIENT_ADAPTER>"
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
