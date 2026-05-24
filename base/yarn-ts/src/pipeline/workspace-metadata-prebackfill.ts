import type { ClientMetadata } from "../providers/prefix-optimizer/index.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";

export interface WorkspacePrebackfillSessionState {
  record: { metadata: Record<string, unknown> };
}

export interface WorkspacePrebackfillResult {
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  applied: boolean;
  metadata: ClientMetadata | null;
}

export function applyWorkspaceMetadataPrebackfill<TSession extends WorkspacePrebackfillSessionState>(input: {
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  messages: unknown[];
  session: TSession;
  requestId: string;
  extractMetadataFromMessages: (messages: unknown[]) => ClientMetadata;
  buildAdapterBlock: (pathContext: SessionPathHints) => string | undefined;
  setWorkspaceContext: (
    session: TSession,
    status: "ready",
    requestId: string,
    details: { reason: string; projectRoot?: string; cwd?: string; shell?: string; os?: string; arch?: string },
  ) => void;
  logInfo?: (record: Record<string, unknown>, message: string) => void;
  logSessionKey?: string;
}): WorkspacePrebackfillResult {
  if (input.pathContext.projectRoot && input.pathContext.shellCwd) {
    return {
      pathContext: input.pathContext,
      adapterBlock: input.adapterBlock,
      applied: false,
      metadata: null,
    };
  }

  const metadata = input.extractMetadataFromMessages(input.messages);
  if (!metadata.projectRoot && !metadata.shellCwd) {
    return {
      pathContext: input.pathContext,
      adapterBlock: input.adapterBlock,
      applied: false,
      metadata,
    };
  }

  const pathContext: SessionPathHints = {
    ...input.pathContext,
    projectRoot: input.pathContext.projectRoot ?? metadata.projectRoot,
    shellCwd: input.pathContext.shellCwd ?? metadata.shellCwd,
    shell: input.pathContext.shell ?? metadata.shell ?? undefined,
    platform: input.pathContext.platform ?? metadata.platform ?? undefined,
    osVersion: input.pathContext.osVersion ?? metadata.osVersion ?? undefined,
  };
  const adapterBlock = input.buildAdapterBlock(pathContext);

  input.setWorkspaceContext(input.session, "ready", input.requestId, {
    reason: "Extracted from client system message (pre-enrich)",
    projectRoot: metadata.projectRoot ?? undefined,
    cwd: metadata.shellCwd ?? undefined,
    shell: metadata.shell ?? undefined,
    os: metadata.platform ?? undefined,
    arch: metadata.osVersion ?? undefined,
  });
  input.logInfo?.(
    {
      sessionKey: input.logSessionKey,
      projectRoot: metadata.projectRoot,
      shellCwd: metadata.shellCwd,
      shell: metadata.shell,
      platform: metadata.platform,
    },
    "prefix_optimizer_metadata_prebackfill",
  );

  return {
    pathContext,
    adapterBlock,
    applied: true,
    metadata,
  };
}
