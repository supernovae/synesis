/**
 * Default non-interactive environment for MCP `execFile` tool runs.
 * Values are applied only when the key is missing or empty on `process.env`.
 */

export type SynesisToolEnv = Record<string, string>;

/**
 * Keys documented in docs/coder/TERMINAL_INTERCEPTION.md — keep in sync.
 */
export function getDefaultSynesisToolEnv(): SynesisToolEnv {
  return {
    CI: "1",
    DEBIAN_FRONTEND: "noninteractive",
    NEEDRESTART_MODE: "a",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PIP_NO_INPUT: "1",
    PYTHONUNBUFFERED: "1",
    npm_config_yes: "true",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

export function mergeSynesisToolEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defaults = getDefaultSynesisToolEnv();
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(defaults)) {
    const cur = out[k];
    if (cur === undefined || cur === "") {
      out[k] = v;
    }
  }
  return out;
}
