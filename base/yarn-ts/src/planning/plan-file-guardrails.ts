import { readdir } from "node:fs/promises";

import {
  buildBlockedDiscoveryGuidance,
  buildBlockedDiscoveryRecoveryWithSnapshot,
  buildBlockedDiscoveryRecoveryWithoutSnapshot,
  type BlockedDiscoveryDetail,
} from "../tool-collapse/blocked-discovery-recovery.js";
import {
  applyDiscoveryGuardrails,
  type DiscoveryGuardrailRedirect,
} from "../tool-collapse/discovery-guardrails.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import {
  buildShadowFromContent,
  type PlanContentShadow,
} from "./plan-content-shadow.js";
import { injectGovernorRecoveryMessage } from "../pipeline/route-tool-preparation.js";

export type DiscoveryRecoverySnapshot = {
  text: string;
  entryCount: number;
  usedTopLevelSnapshot: boolean;
  recoveryMode: "top_level_snapshot" | "no_project_root" | "root_empty" | "snapshot_io_error";
};

function blockedInputPreview(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  const trimmed: Record<string, unknown> = {};
  for (const key of ["glob_pattern", "pattern", "glob", "query", "path", "directory", "dir"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) trimmed[key] = value.trim().slice(0, 80);
  }
  const keys = Object.keys(trimmed);
  if (keys.length === 0) return undefined;
  return JSON.stringify(trimmed);
}

export async function buildBlockedDiscoveryRecoverySnapshot(
  family: string,
  blocked: BlockedDiscoveryDetail[],
  projectRoot: string | null | undefined,
): Promise<DiscoveryRecoverySnapshot> {
  const base = buildBlockedDiscoveryGuidance(family, blocked);
  const safeRoot = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (!safeRoot) {
    return {
      text: buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "no_project_root"),
      entryCount: 0,
      usedTopLevelSnapshot: false,
      recoveryMode: "no_project_root",
    };
  }
  try {
    const entries = await readdir(safeRoot, { withFileTypes: true });
    const normalized = entries
      .map((entry): { name: string; kind: "dir" | "file" } => ({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
      }))
      .filter((entry) => entry.name && !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    if (normalized.length === 0) {
      return {
        text: buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "root_empty"),
        entryCount: 0,
        usedTopLevelSnapshot: false,
        recoveryMode: "root_empty",
      };
    }
    const withPreview = buildBlockedDiscoveryRecoveryWithSnapshot(base, normalized);
    return {
      text: withPreview.text,
      entryCount: withPreview.previewCount,
      usedTopLevelSnapshot: true,
      recoveryMode: "top_level_snapshot",
    };
  } catch {
    return {
      text: buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "snapshot_io_error"),
      entryCount: 0,
      usedTopLevelSnapshot: false,
      recoveryMode: "snapshot_io_error",
    };
  }
}

const topLevelDirCache = new Map<string, { dirs: string[]; cachedAt: number }>();
const TOP_LEVEL_DIR_CACHE_TTL = 120_000;

export async function getCachedTopLevelDirs(projectRoot: string | null | undefined): Promise<string[]> {
  const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (!root) return [];
  const cached = topLevelDirCache.get(root);
  if (cached && Date.now() - cached.cachedAt < TOP_LEVEL_DIR_CACHE_TTL) return cached.dirs;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    topLevelDirCache.set(root, { dirs, cachedAt: Date.now() });
    return dirs;
  } catch {
    return [];
  }
}

export function applyDiscoveryToolGuardrail(
  calls: GuardrailToolCall[],
  topLevelDirs?: string[],
): {
  calls: GuardrailToolCall[];
  blockedCount: number;
  redirectedCount: number;
  collapsedCount: number;
  blockedDetails: BlockedDiscoveryDetail[];
  redirectedDetails: DiscoveryGuardrailRedirect[];
} {
  const guarded = applyDiscoveryGuardrails(calls, topLevelDirs);
  const callById = new Map(calls.map((call) => [call.toolCallId, call]));
  return {
    calls: guarded.calls as GuardrailToolCall[],
    blockedCount: guarded.blocked.length,
    redirectedCount: guarded.redirected.length,
    collapsedCount: guarded.collapsed.length,
    blockedDetails: guarded.blocked.map((b) => ({
      toolName: b.toolName,
      reason: b.reason,
      argsPreview: blockedInputPreview(callById.get(b.toolCallId)?.input),
    })),
    redirectedDetails: guarded.redirected,
  };
}

const FILE_UNCHANGED_RE = /<FILE_UNCHANGED\s[^>]*path="([^"]+)"/i;

export function remediatePlanFileStubs(
  messages: Array<{ role: string; content: unknown }>,
): { messages: Array<{ role: string; content: unknown }>; remediatedCount: number } {
  let remediatedCount = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const text = m.content;
    if (!text.includes("<FILE_UNCHANGED")) return m;
    const pathMatch = text.match(FILE_UNCHANGED_RE);
    const extractedPath = pathMatch?.[1] ?? null;
    if (!extractedPath) return m;
    const isPlan = extractedPath.includes("/.claude/plans/") || extractedPath.includes("\\.claude\\plans\\");
    if (!isPlan) return m;
    remediatedCount += 1;
    return {
      ...m,
      content: [
        `<SYNESIS_TOOL_GUARDRAIL status="guided" code="plan_file_dedup_remediation" version="1">`,
        `file_path=${extractedPath}`,
        `reason=plan_file_incorrectly_deduplicated`,
        `next_action=read_plan_file_with_bash`,
        `[Plan file stub] A plan file was incorrectly deduplicated. You do not have the plan content.`,
        `Use Bash(cat ${extractedPath}) to retrieve the full plan file content.`,
        `</SYNESIS_TOOL_GUARDRAIL>`,
      ].join("\n"),
    };
  });
  return { messages: out, remediatedCount };
}

const PLAN_FILE_PATH_KEYS = ["filePath", "file_path", "path", "file", "fileName", "file_name"];
const PLAN_READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "file_read", "str_replace_editor"]);
const PLAN_WRITE_TOOL_NAMES = new Set([
  "write", "write_file", "writefile", "edit", "update",
  "str_replace_editor", "apply_patch", "file_write",
]);

function isPlanPath(p: string): boolean {
  return p.includes("/.claude/plans/") || p.includes("\\.claude\\plans\\");
}

function resolveToolCallPlanPaths(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
  toolNameSet: Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const toolCalls = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const id = typeof tc?.id === "string" ? tc.id : "";
      const fnName = typeof tc?.function?.name === "string" ? tc.function.name.toLowerCase() : "";
      if (!id || !toolNameSet.has(fnName)) continue;
      let argsRaw = tc?.function?.arguments;
      if (typeof argsRaw === "string") {
        try { argsRaw = JSON.parse(argsRaw); } catch { continue; }
      }
      if (!argsRaw || typeof argsRaw !== "object") continue;
      const args = argsRaw as Record<string, unknown>;
      for (const key of PLAN_FILE_PATH_KEYS) {
        if (typeof args[key] === "string" && args[key]) {
          map.set(id, args[key] as string);
          break;
        }
      }
    }
  }
  return map;
}

export function annotatePlanFileReads(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
): { messages: Array<{ role: string; tool_call_id?: string; content: unknown }>; annotatedCount: number; planFilePaths: string[] } {
  const readPathMap = resolveToolCallPlanPaths(messages, PLAN_READ_TOOL_NAMES);
  const writePathMap = resolveToolCallPlanPaths(messages, PLAN_WRITE_TOOL_NAMES);

  const editedPlanPaths = new Set<string>();
  for (const [, path] of writePathMap) {
    if (isPlanPath(path)) editedPlanPaths.add(path);
  }

  const lastEditIndexByPath = new Map<string, number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || !m.tool_call_id) continue;
    const writePath = writePathMap.get(m.tool_call_id);
    if (writePath && isPlanPath(writePath) && !lastEditIndexByPath.has(writePath)) {
      lastEditIndexByPath.set(writePath, i);
    }
  }

  let annotatedCount = 0;
  let cachedPlanReads = 0;
  const planFilePaths: string[] = [];
  const planPathHasFullRead = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const rp = m.tool_call_id ? readPathMap.get(m.tool_call_id) : undefined;
    if (rp && isPlanPath(rp) && m.content.length > 200 && !m.content.includes("read_cache_stub") && !m.content.includes("Unchanged")) {
      planPathHasFullRead.add(rp);
    }
  }

  const out = messages.map((m, idx) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const text = m.content;
    if (text.includes("<SYNESIS_PLAN_LOADED") || text.includes("<SYNESIS_PLAN_UPDATED") || text.includes("<SYNESIS_PLAN_ALREADY_UPDATED")) return m;

    const resolvedReadPath = m.tool_call_id ? readPathMap.get(m.tool_call_id) : undefined;
    const resolvedWritePath = m.tool_call_id ? writePathMap.get(m.tool_call_id) : undefined;

    if (resolvedReadPath && isPlanPath(resolvedReadPath) && !editedPlanPaths.has(resolvedReadPath)) {
      const isStub =
        text.length < 80
        || text.includes("read_cache_stub")
        || text.toLowerCase().includes("unchanged");
      if (isStub) {
        if (!planFilePaths.includes(resolvedReadPath)) planFilePaths.push(resolvedReadPath);
        annotatedCount += 1;
        cachedPlanReads += 1;
        const hasContent = planPathHasFullRead.has(resolvedReadPath);
        if (cachedPlanReads >= 3) {
          return {
            ...m,
            content: [
              `<SYNESIS_PLAN_LOADED path="${resolvedReadPath}" cached="true" reread_count="${cachedPlanReads}" severity="critical">`,
              `⛔ CRITICAL: You have re-read this plan file ${cachedPlanReads} times. It has NOT changed. STOP READING IT.`,
              `You are stuck in a loop. The plan content is already in this conversation.`,
              `DO NOT: re-read the plan, re-summarize completed items, search the codebase to verify completed items, or declare intent without acting.`,
              `DO THIS NOW: Pick the next incomplete task and make ONE code edit (Write/Edit). Nothing else.`,
              `</SYNESIS_PLAN_LOADED>`,
            ].join("\n"),
          };
        }
        return {
          ...m,
          content: [
            `<SYNESIS_PLAN_LOADED path="${resolvedReadPath}" cached="true" reread_count="${cachedPlanReads}">`,
            hasContent
              ? `The plan file is unchanged. You already have its full content from an earlier read in this conversation.`
              : `The plan file was read previously but the content may have been pruned. Use Bash(cat ${resolvedReadPath}) once if you need to see it.`,
            `Do NOT call Read on this file again. Do NOT re-read it. Do NOT say "I've already read this."`,
            hasContent
              ? `Refer to the plan content above. Identify the next INCOMPLETE task and begin working on it immediately.`
              : `After one cat, identify the next incomplete task and begin working on it immediately.`,
            `Trust the plan's status markers. Do NOT search or grep to re-verify items marked complete.`,
            `</SYNESIS_PLAN_LOADED>`,
          ].join("\n"),
        };
      }
    }

    if (text.length < 50) return m;

    if (resolvedReadPath && isPlanPath(resolvedReadPath)) {
      if (!planFilePaths.includes(resolvedReadPath)) planFilePaths.push(resolvedReadPath);
      if (editedPlanPaths.has(resolvedReadPath)) {
        annotatedCount += 1;
        return {
          ...m,
          content: text + "\n\n" + [
            `<SYNESIS_PLAN_ALREADY_UPDATED path="${resolvedReadPath}">`,
            `You already updated this plan file earlier in this conversation.`,
            `Do NOT update it again. Do NOT re-read it. The plan is current.`,
            `Proceed with the next incomplete task or ask the user what to do.`,
            `</SYNESIS_PLAN_ALREADY_UPDATED>`,
          ].join("\n"),
        };
      }
      annotatedCount += 1;
      return {
        ...m,
        content: text + "\n\n" + [
          `<SYNESIS_PLAN_LOADED path="${resolvedReadPath}">`,
          `You have loaded a plan file. Your IMMEDIATE next actions:`,
          `1. Parse the task list from the YAML frontmatter above (look for 'todos:' or task entries with 'status:')`,
          `2. Display a progress summary table: completed tasks vs remaining tasks with their descriptions`,
          `3. State which task is next`,
          `4. Begin working on that task immediately — make a concrete code edit`,
          `Trust the plan's status markers. Do NOT search or grep the codebase to re-verify items already marked complete.`,
          `Do NOT re-read this file. Do NOT explore the repository before starting work.`,
          `</SYNESIS_PLAN_LOADED>`,
        ].join("\n"),
      };
    }

    if (resolvedWritePath && isPlanPath(resolvedWritePath) && lastEditIndexByPath.get(resolvedWritePath) === idx) {
      if (!planFilePaths.includes(resolvedWritePath)) planFilePaths.push(resolvedWritePath);
      annotatedCount += 1;
      return {
        ...m,
        content: text + "\n\n" + [
          `<SYNESIS_PLAN_UPDATED path="${resolvedWritePath}">`,
          `You have updated the plan file. The edit above reflects the latest task state.`,
          `Do NOT re-read the plan file. Do NOT re-display the progress summary you already showed.`,
          `The plan is updated. Proceed with the next task or ask the user what to do next.`,
          `</SYNESIS_PLAN_UPDATED>`,
        ].join("\n"),
      };
    }

    if (!resolvedReadPath && !resolvedWritePath) {
      const isPlan = text.includes("/.claude/plans/") && /---\n/.test(text);
      if (isPlan) {
        planFilePaths.push("unknown-plan");
        annotatedCount += 1;
        return {
          ...m,
          content: text + "\n\n" + [
            `<SYNESIS_PLAN_LOADED path="the plan file">`,
            `You have loaded a plan file. Your IMMEDIATE next actions:`,
            `1. Parse the task list from the YAML frontmatter above (look for 'todos:' or task entries with 'status:')`,
            `2. Display a progress summary table: completed tasks vs remaining tasks with their descriptions`,
            `3. State which task is next`,
            `4. Begin working on that task immediately — make a concrete code edit`,
            `Trust the plan's status markers. Do NOT search or grep the codebase to re-verify items already marked complete.`,
            `Do NOT re-read this file. Do NOT explore the repository before starting work.`,
            `</SYNESIS_PLAN_LOADED>`,
          ].join("\n"),
        };
      }
    }

    return m;
  });
  return { messages: out, annotatedCount, planFilePaths };
}

const PLAN_MODE_ERROR_RE = /not in plan mode|only for exiting plan mode/i;
const EXIT_PLAN_MODE_ALREADY_APPROVED_RE =
  /only for exiting plan mode|already approved|continue with implementation|you can now start coding/i;

export function injectPlanModeRecoveryHint(
  messages: Array<{ role: string; content: unknown }>,
): boolean {
  const tail = messages.slice(-6);
  const hasPlanModeError = tail.some((m) => {
    if (m.role !== "tool" && m.role !== "user") return false;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return PLAN_MODE_ERROR_RE.test(text);
  });
  if (!hasPlanModeError) return false;

  const tailText = tail
    .map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))
    .join("\n");
  const hint = EXIT_PLAN_MODE_ALREADY_APPROVED_RE.test(tailText)
    ? [
        "<SYNESIS_EXECUTION_RECOVERY source=\"plan_mode_exit_already_approved\">",
        "The client rejected ExitPlanMode because plan mode has already ended or the plan was already approved.",
        "This recovery instruction is newer and more specific than any stale plan-mode reminder still present in the transcript.",
        "Treat plan mode as closed for this implementation turn even if older context says plan mode is active.",
        "Do NOT call ExitPlanMode again. Do NOT update or rewrite the plan file again.",
        "Continue with implementation now: create/update the next project file from the approved plan, then update native task/plan status after real progress.",
        "</SYNESIS_EXECUTION_RECOVERY>",
      ].join("\n")
    : [
        "<SYNESIS_EXECUTION_RECOVERY source=\"plan_mode_error\">",
        "The client's plan update tool rejected your update because you are not in plan mode.",
        "Only if the plan file itself still needs updating, use the Write tool or Bash (e.g., cat > path) to write that plan file directly.",
        "Do NOT attempt to use the plan tool again — it only works in plan mode.",
        "If the plan is already complete or approved, stop editing the plan and continue with the implementation task.",
        "</SYNESIS_EXECUTION_RECOVERY>",
      ].join("\n");

  injectGovernorRecoveryMessage(messages, hint);
  return true;
}

export function extractPlanContentShadow(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
  planFilePaths: string[],
): PlanContentShadow | null {
  if (planFilePaths.length === 0) return null;
  const readPathMap = resolveToolCallPlanPaths(messages, PLAN_READ_TOOL_NAMES);
  let bestShadow: PlanContentShadow | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const rp = m.tool_call_id ? readPathMap.get(m.tool_call_id) : undefined;
    if (!rp || !isPlanPath(rp)) continue;
    const text = m.content;
    if (text.length < 200) continue;
    if (text.includes("read_cache_stub") || text.toLowerCase().includes("unchanged")) continue;
    bestShadow = buildShadowFromContent(rp, text);
    break;
  }
  return bestShadow;
}

const NO_TEST_FILES_RE = /\[no test files\]/i;
const PACKAGE_PATH_RE = /\?\s+(\S+)\s+\[no test files\]/;

export function annotateVerificationGaps(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
): { messages: Array<{ role: string; tool_call_id?: string; content: unknown }>; annotatedCount: number } {
  const shellToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const toolCalls = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const id = typeof tc?.id === "string" ? tc.id : "";
      const fnName = typeof tc?.function?.name === "string" ? tc.function.name.toLowerCase() : "";
      if (!id) continue;
      if (fnName.includes("bash") || fnName.includes("shell") || fnName.includes("run_command") || fnName.includes("execute")) {
        shellToolCallIds.add(id);
      }
    }
  }

  let annotatedCount = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const text = m.content;
    if (!NO_TEST_FILES_RE.test(text)) return m;
    if (text.includes("<SYNESIS_VERIFICATION_GAP")) return m;
    if (!m.tool_call_id || !shellToolCallIds.has(m.tool_call_id)) return m;

    const pkgMatch = text.match(PACKAGE_PATH_RE);
    const pkg = pkgMatch?.[1] ?? "the package";
    const lastSegment = pkg.includes("/") ? pkg.split("/").pop() : pkg;
    const testFileName = `${lastSegment}_test.go`;

    annotatedCount += 1;
    return {
      ...m,
      content: text + "\n\n" + [
        `<SYNESIS_VERIFICATION_GAP code="no_test_files">`,
        `package=${pkg}`,
        `There are NO test files for this package. Re-running "go test" will produce the same result.`,
        `ACTION REQUIRED: Create a test file (e.g. ${testFileName}) with test functions, then run the test command once.`,
        `Do NOT re-run "go test" until you have written a test file.`,
        `</SYNESIS_VERIFICATION_GAP>`,
      ].join("\n"),
    };
  });
  return { messages: out, annotatedCount };
}
