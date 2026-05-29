import { contextFromSessionMetadata } from "./workspace-context-handshake.js";

export interface SessionPathContext {
  projectRoot?: string | null;
  shellCwd?: string | null;
  shell?: string;
  platform?: string;
  osVersion?: string;
}

interface SessionMetadataCarrier {
  record?: {
    metadata?: Record<string, unknown> | null;
  } | null;
}

/**
 * Last-mile path guards should not depend on every upstream route carrying
 * fresh pathContext. Once a workspace handshake has persisted metadata on the
 * coder session, rehydrate missing roots from that durable session record.
 */
export function mergePathContextWithSessionMetadata<T extends SessionPathContext>(
  base: T,
  session: unknown,
): T {
  const metadata = (session as SessionMetadataCarrier | null | undefined)?.record?.metadata;
  if (!metadata) return base;

  const fromSession = contextFromSessionMetadata(metadata);
  if (!fromSession) return base;

  const projectRoot = nonEmpty(base.projectRoot) ?? nonEmpty(fromSession.projectRoot) ?? nonEmpty(fromSession.cwd) ?? null;
  const shellCwd = nonEmpty(base.shellCwd) ?? nonEmpty(fromSession.cwd) ?? nonEmpty(fromSession.projectRoot) ?? null;

  if (
    projectRoot === (base.projectRoot ?? null)
    && shellCwd === (base.shellCwd ?? null)
    && (base.shell || !fromSession.shell)
    && (base.platform || !fromSession.os)
    && (base.osVersion || !fromSession.arch)
  ) {
    return base;
  }

  return {
    ...base,
    projectRoot,
    shellCwd,
    shell: base.shell ?? fromSession.shell,
    platform: base.platform ?? fromSession.os,
    osVersion: base.osVersion ?? fromSession.arch,
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
