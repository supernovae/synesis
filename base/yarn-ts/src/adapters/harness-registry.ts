/** Client identity is a routing hint, never a tool capability or permission grant. */
export const HARNESS_PROFILES = [
  { id: "claude-code", aliases: ["claude-code"], mode: "cli" },
  { id: "codex-cli", aliases: ["codex-cli", "codex"], mode: "cli" },
  { id: "opencode", aliases: ["opencode", "roo-opencode"], mode: "cli" },
  { id: "hermes-agent", aliases: ["hermes-agent", "hermes"], mode: "cli" },
  { id: "deepseek-harness", aliases: ["deepseek-harness", "dsh", "@deepseek-ai/dsh"], mode: "ide" },
  { id: "gemini-cli", aliases: ["gemini-cli"], mode: "cli" },
  { id: "pi", aliases: ["pi", "pi-coding-agent"], mode: "cli" },
  { id: "goose", aliases: ["goose"], mode: "cli" },
  { id: "aider", aliases: ["aider"], mode: "cli" },
  { id: "openclaw", aliases: ["openclaw", "open-claw"], mode: "cli" },
  ...["cursor", "vscode-copilot", "windsurf", "junie", "continue", "roo", "cline", "zed", "jetbrains"].map(id => ({ id, aliases: [id], mode: "ide" as const })),
  { id: "synesis-acp", aliases: ["synesis-acp"], mode: "mcp_native" },
] as const;

export function findHarnessProfile(client: string | null | undefined) {
  const name = (client ?? "").trim().toLowerCase();
  return HARNESS_PROFILES.find(profile => profile.aliases.some(alias =>
    name === alias || name.startsWith(`${alias}/`) || name.startsWith(`${alias}-`)
  ));
}

/** User agents may contain SDK names; an SDK/provider name is not a harness. */
export function inferHarnessFromUserAgent(userAgent: string): string | null {
  for (const token of userAgent.toLowerCase().split(/\s+/)) {
    const profile = findHarnessProfile(token);
    if (profile) return profile.id;
  }
  return null;
}

export function resolveHarnessClient(
  headers: Record<string, unknown>,
  metadata?: Record<string, unknown> | null,
  fallback = "unknown",
): string {
  const first = (value: unknown): string | null => {
    const v = Array.isArray(value) ? value[0] : value;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const explicit = first(headers["x-synesis-client"]);
  if (explicit) return explicit;
  for (const key of ["synesis_client", "synesis_acp_client_name"]) {
    const name = first(metadata?.[key]);
    if (name) return name.toLowerCase().replace(/\s+/g, "-");
  }
  return inferHarnessFromUserAgent(first(headers["user-agent"]) ?? "") ?? fallback;
}
