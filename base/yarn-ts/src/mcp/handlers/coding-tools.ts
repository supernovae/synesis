import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  DEFAULT_AGENT_ALLOWED_REPO_OPS,
  DecisionRecordSchema,
  GuardedRepoOpsAdapter,
  REPO_OPERATION_IDS,
  RequestResponseRuntime,
  type RepoOperationRequest,
  type RepoOperationResult,
} from "@synesis/agent-orchestration";
import type { McpToolDefinition } from "../tool-registry.js";
import {
  extractDiagnosticLines,
  extractStructuredErrors,
  MAX_STREAM_CHARS,
  truncateStream,
  type StructuredDiagnostic,
} from "./command-diagnostics.js";
import { shapeTerminalOutput, type ShapingStats } from "../../terminal/output-shaper.js";
import { mergeSynesisToolEnv } from "../../terminal/tool-env.js";
import {
  attachShapingToSignals,
  classifyTerminalOutput,
  formatTerminalVerificationHint,
  type TerminalSignals,
} from "../../terminal/terminal-signals.js";

const execFileAsync = promisify(execFile);

function terminalShapingEnabled(): boolean {
  return (process.env.SYNESIS_YARN_TERMINAL_SHAPING_ENABLED ?? "true").toLowerCase() !== "false";
}

function addShapingStats(a: ShapingStats, b: ShapingStats): ShapingStats {
  return {
    ansiEscapeBytesRemoved: a.ansiEscapeBytesRemoved + b.ansiEscapeBytesRemoved,
    carriageReturnSegmentsCollapsed: a.carriageReturnSegmentsCollapsed + b.carriageReturnSegmentsCollapsed,
    repeatedLineRunsCollapsed: a.repeatedLineRunsCollapsed + b.repeatedLineRunsCollapsed,
    inputChars: a.inputChars + b.inputChars,
    outputChars: a.outputChars + b.outputChars,
  };
}

/**
 * Shape stdout/stderr for MCP preset runners, then classify for structured terminalSignals.
 */
function processRunnerStreams(stdout: string, stderr: string): {
  stdoutOut: string;
  stderrOut: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  terminalSignals: TerminalSignals;
} {
  const skip = !terminalShapingEnabled();
  const so = shapeTerminalOutput(stdout, { skip });
  const se = shapeTerminalOutput(stderr, { skip });
  const mergedStats = addShapingStats(so.stats, se.stats);
  const combined = `${se.text}\n---\n${so.text}`;
  const signals = classifyTerminalOutput(combined, { shapingStats: mergedStats });
  const terminalSignals = attachShapingToSignals(signals, [...se.shapingApplied, ...so.shapingApplied], mergedStats);
  const out = truncateStream(so.text, MAX_STREAM_CHARS);
  const err = truncateStream(se.text, MAX_STREAM_CHARS);
  return {
    stdoutOut: out.text,
    stderrOut: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    terminalSignals,
  };
}

function applyTerminalToSandboxResult(result: Record<string, unknown>): Record<string, unknown> {
  const skip = !terminalShapingEnabled();
  const lint = result.lint as Record<string, unknown> | undefined;
  const exec = result.execution as Record<string, unknown> | undefined;
  const chunks: string[] = [];
  let mergedShaping: string[] = [];
  let mergedStats: ShapingStats = {
    ansiEscapeBytesRemoved: 0,
    carriageReturnSegmentsCollapsed: 0,
    repeatedLineRunsCollapsed: 0,
    inputChars: 0,
    outputChars: 0,
  };

  if (lint && typeof lint.output === "string") {
    const s = shapeTerminalOutput(lint.output, { skip });
    lint.output = s.text;
    chunks.push(s.text);
    mergedShaping = [...mergedShaping, ...s.shapingApplied];
    mergedStats = addShapingStats(mergedStats, s.stats);
  }
  if (exec && typeof exec.output === "string") {
    const s = shapeTerminalOutput(exec.output, { skip });
    exec.output = s.text;
    chunks.push(s.text);
    mergedShaping = [...mergedShaping, ...s.shapingApplied];
    mergedStats = addShapingStats(mergedStats, s.stats);
  }

  const combined = chunks.join("\n");
  const signals = classifyTerminalOutput(combined, { shapingStats: mergedStats });
  const terminal_signals = attachShapingToSignals(signals, mergedShaping, mergedStats);
  return { ...result, terminal_signals };
}

const MAX_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 2000;
const MAX_SEARCH_RESULTS = 500;

const RootSchema = z.object({
  projectRoot: z.string().min(1).describe("Absolute project root path"),
});

const RelPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !path.isAbsolute(v), "Path must be relative to project root");

function resolveInsideRoot(projectRoot: string, rel: string): string {
  const root = path.resolve(projectRoot);
  const cleaned = rel.replace(/\0/g, "").trim();
  if (!cleaned || path.isAbsolute(cleaned)) {
    throw new Error("Path must be a non-empty relative path");
  }
  const resolved = path.resolve(root, cleaned);
  const relFromRoot = path.relative(root, resolved);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    throw new Error("Path escapes project root");
  }
  return resolved;
}

async function runCommand(
  projectRoot: string,
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: projectRoot,
      maxBuffer: 8 * 1024 * 1024,
      env: mergeSynesisToolEnv(process.env),
    });
    return { exitCode: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const code = typeof e.code === "number" ? e.code : 1;
    return {
      exitCode: code,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? "command failed"),
    };
  }
}

async function walkDir(dir: string, maxDepth: number, includeHidden: boolean): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: dir, rel: ".", depth: 0 }];
  while (queue.length > 0 && out.length < MAX_LIST_ENTRIES) {
    const item = queue.shift()!;
    const entries = await fs.readdir(item.abs, { withFileTypes: true });
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith(".")) continue;
      const rel = item.rel === "." ? e.name : `${item.rel}/${e.name}`;
      out.push(rel);
      if (out.length >= MAX_LIST_ENTRIES) break;
      if (e.isDirectory() && item.depth < maxDepth) {
        queue.push({ abs: path.join(item.abs, e.name), rel, depth: item.depth + 1 });
      }
    }
  }
  return out;
}

type DirEntryMeta = {
  path: string;
  kind: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
};

async function listDirWithMetadata(
  projectRoot: string,
  dir: string,
  maxDepth: number,
  includeHidden: boolean,
): Promise<{ entries: string[]; meta: DirEntryMeta[]; truncated: boolean }> {
  const entries = await walkDir(dir, maxDepth, includeHidden);
  const bounded = entries.slice(0, MAX_LIST_ENTRIES);
  const meta: DirEntryMeta[] = [];
  for (const rel of bounded) {
    const abs = path.resolve(dir, rel);
    try {
      const stat = await fs.stat(abs);
      meta.push({
        path: rel,
        kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      meta.push({
        path: rel,
        kind: "other",
        size: 0,
        mtimeMs: 0,
      });
    }
  }
  const truncated = entries.length >= MAX_LIST_ENTRIES;
  // Ensure path fields are always project-root relative even when dir != "."
  const dirPrefix = path.relative(path.resolve(projectRoot), path.resolve(dir)).replace(/\\/g, "/");
  const normalize = (p: string) => (dirPrefix && dirPrefix !== "." ? `${dirPrefix}/${p}` : p);
  return {
    entries: bounded.map(normalize),
    meta: meta.map((m) => ({ ...m, path: normalize(m.path) })),
    truncated,
  };
}

async function walkFilesForSearch(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_LIST_ENTRIES) {
    const item = queue.shift()!;
    const entries = await fs.readdir(item.abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".git")) continue;
      const abs = path.join(item.abs, e.name);
      if (e.isDirectory()) {
        if (item.depth < maxDepth) queue.push({ abs, depth: item.depth + 1 });
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

const RUN_TEST_PRESETS: Record<string, [string, ...string[]]> = {
  go: ["go", "test", "./..."],
  python: ["pytest", "-q"],
  python_pytest_short: ["pytest", "--tb=short"],
  node_npm: ["npm", "test"],
  node_pnpm: ["pnpm", "test"],
  node_yarn: ["yarn", "test"],
  typescript_jest: ["npx", "jest", "--passWithNoTests"],
  rust: ["cargo", "test"],
};

const RUN_BUILD_PRESETS: Record<string, [string, ...string[]]> = {
  go: ["go", "build", "./..."],
  python: ["python", "-m", "compileall", "."],
  python_mypy: ["mypy", "."],
  node_npm: ["npm", "run", "build"],
  node_pnpm: ["pnpm", "build"],
  node_yarn: ["yarn", "build"],
  typescript_tsc: ["npx", "tsc", "--noEmit"],
  rust: ["cargo", "build"],
};

const RUN_LINT_PRESETS: Record<string, [string, ...string[]]> = {
  go: ["go", "vet", "./..."],
  go_golangci: ["golangci-lint", "run"],
  python: ["ruff", "check", "."],
  python_ruff_format_check: ["ruff", "format", "--check", "."],
  node_npm: ["npm", "run", "lint"],
  node_pnpm: ["pnpm", "lint"],
  node_yarn: ["yarn", "lint"],
  typescript_eslint: ["npx", "eslint", "."],
  rust: ["cargo", "clippy", "--", "-D", "warnings"],
};

const FORMAT_PRESETS: Record<string, [string, ...string[]]> = {
  go: ["gofmt", "-w", "."],
  python: ["ruff", "format", "."],
  node_npm: ["npm", "run", "format"],
  node_pnpm: ["pnpm", "format"],
  node_yarn: ["yarn", "format"],
  rust: ["cargo", "fmt"],
};

const BlockedGitPaths = [/^\.env($|\.)/i, /credentials/i, /secret/i, /token/i];
type GitPolicyMode = "off" | "advisory" | "enforced";

function gitPolicyModeFromEnv(): GitPolicyMode {
  const raw = String(process.env.SYNESIS_YARN_GIT_POLICY_MODE ?? "advisory").trim().toLowerCase();
  if (raw === "off" || raw === "advisory" || raw === "enforced") return raw;
  return "advisory";
}

function branchFromStatusHeader(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("## "));
  if (!line) return null;
  const candidate = line.slice(3).trim().split("...")[0]?.trim() ?? "";
  return candidate || null;
}

async function isGitRepo(projectRoot: string): Promise<boolean> {
  const out = await runCommand(path.resolve(projectRoot), "git", ["rev-parse", "--is-inside-work-tree"]);
  return out.exitCode === 0 && out.stdout.trim() === "true";
}

async function listStagedFiles(projectRoot: string): Promise<string[]> {
  const out = await runCommand(path.resolve(projectRoot), "git", ["diff", "--cached", "--name-only"]);
  if (out.exitCode !== 0) return [];
  return out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const RuntimeContextSchema = RootSchema.extend({
  shellCwd: z.string().optional(),
});
export const getRuntimeContextTool: McpToolDefinition<
  z.infer<typeof RuntimeContextSchema>,
  Record<string, unknown>
> = {
  name: "get_runtime_context",
  description: "Return deterministic runtime/project context for safe tool execution.",
  inputSchema: RuntimeContextSchema,
  handler(input) {
    const projectRoot = path.resolve(input.projectRoot);
    const shellCwd = input.shellCwd ? resolveInsideRoot(projectRoot, input.shellCwd) : projectRoot;
    return {
      projectRoot,
      shellCwd,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      nodeVersion: process.version,
    };
  },
};

const ListDirSchema = RootSchema.extend({
  dir: RelPathSchema.default("."),
  maxDepth: z.number().int().min(0).max(8).default(1),
  includeHidden: z.boolean().default(false),
});
export const listDirTool: McpToolDefinition<
  z.infer<typeof ListDirSchema>,
  {
    entries: string[];
    entriesMeta: DirEntryMeta[];
    count: number;
    truncated: boolean;
    depthLimited: boolean;
    nextAction: string;
  }
> = {
  name: "list_dir",
  description: "List directory entries under project root with bounded recursion.",
  inputSchema: ListDirSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const dir = resolveInsideRoot(root, input.dir);
    const listed = await listDirWithMetadata(root, dir, input.maxDepth, input.includeHidden);
    return {
      entries: listed.entries,
      entriesMeta: listed.meta,
      count: listed.entries.length,
      truncated: listed.truncated,
      depthLimited: input.maxDepth <= 1,
      nextAction: listed.truncated
        ? "Narrow to a sub-directory with list_dir(dir=<path>, maxDepth=1) or search_code(pattern=<symbol>, dir=<path>)."
        : "Pick one candidate sub-directory/file and continue with scoped list_dir/search_code/read_file.",
    };
  },
};

const ReadFileSchema = RootSchema.extend({
  filePath: RelPathSchema,
  maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(200_000),
  /** 1-based inclusive line window; use with search_code hits. Omit to read from file start (still byte-capped). */
  startLine: z.number().int().min(1).optional(),
  /** 1-based inclusive end line; defaults to startLine + 199 when startLine is set. */
  endLine: z.number().int().min(1).optional(),
});
export const readFileTool: McpToolDefinition<
  z.infer<typeof ReadFileSchema>,
  {
    filePath: string;
    content: string;
    truncated: boolean;
    bytes: number;
    lineRange?: { startLine: number; endLine: number };
  }
> = {
  name: "read_file",
  description:
    "Read a UTF-8 file under project root with byte limits. Prefer search_code to find paths first; use optional startLine/endLine (1-based, inclusive) to read a window (~200 lines if endLine omitted) instead of loading huge files from offset 0.",
  inputSchema: ReadFileSchema,
  async handler(input) {
    const abs = resolveInsideRoot(input.projectRoot, input.filePath);
    const raw = await fs.readFile(abs, "utf8");
    let text = raw;
    let lineRange: { startLine: number; endLine: number } | undefined;
    if (input.startLine !== undefined) {
      const lines = raw.split(/\r?\n/);
      const startIdx = Math.max(0, input.startLine - 1);
      const lastLineInclusive = input.endLine ?? input.startLine + 199;
      const endExclusive = Math.min(lines.length, lastLineInclusive);
      text = lines.slice(startIdx, endExclusive).join("\n");
      lineRange = {
        startLine: input.startLine,
        endLine: Math.max(input.startLine, endExclusive),
      };
    }
    const buf = Buffer.from(text, "utf8");
    const truncated = buf.byteLength > input.maxBytes;
    const used = truncated ? buf.subarray(0, input.maxBytes) : buf;
    return {
      filePath: input.filePath,
      content: used.toString("utf8"),
      truncated,
      bytes: used.byteLength,
      ...(lineRange ? { lineRange } : {}),
    };
  },
};

const WriteFileSchema = RootSchema.extend({
  filePath: RelPathSchema,
  content: z.string().max(MAX_WRITE_BYTES),
  createDirs: z.boolean().default(true),
});
export const writeFileTool: McpToolDefinition<
  z.infer<typeof WriteFileSchema>,
  { filePath: string; bytes: number; written: true }
> = {
  name: "write_file",
  description: "Write a UTF-8 file under project root with strict path containment.",
  inputSchema: WriteFileSchema,
  async handler(input) {
    const abs = resolveInsideRoot(input.projectRoot, input.filePath);
    if (input.createDirs) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
    }
    await fs.writeFile(abs, input.content, "utf8");
    return { filePath: input.filePath, bytes: Buffer.byteLength(input.content, "utf8"), written: true };
  },
};

const StrReplaceSchema = RootSchema.extend({
  filePath: RelPathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
});
const TakeScreenshotSchema = RootSchema.extend({
  url: z.string().url().describe("The URL to take a screenshot of (e.g., http://localhost:3000)"),
  width: z.number().int().min(320).max(3840).default(1280),
  height: z.number().int().min(240).max(2160).default(800),
  delayMs: z.number().int().min(0).max(10000).default(1000).describe("Wait time before taking screenshot"),
});

export const takeScreenshotTool: McpToolDefinition<
  z.infer<typeof TakeScreenshotSchema>,
  { exitCode: number; imagePath?: string; error?: string }
> = {
  name: "take_screenshot",
  description: "Take a headless screenshot of a URL using Playwright. Useful for visually verifying UI changes. Saves image to project root.",
  inputSchema: TakeScreenshotSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const filename = `screenshot-${Date.now()}.png`;
    const absPath = path.join(root, filename);

    const url = process.env.SYNESIS_VISION_WORKER_URL || "http://synesis-vision-worker.synesis-yarn.svc.cluster.local:8080/screenshot";

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: input.url,
          width: input.width,
          height: input.height,
          delayMs: input.delayMs,
        }),
      });

      if (!resp.ok) {
        return { exitCode: 1, error: `Vision worker returned HTTP ${resp.status}: ${await resp.text()}` };
      }

      const result = await resp.json() as { success: boolean; image_base64?: string; error?: string };
      if (!result.success || !result.image_base64) {
        return { exitCode: 1, error: result.error || "Failed to take screenshot" };
      }

      const buffer = Buffer.from(result.image_base64, "base64");
      await fs.writeFile(absPath, buffer);
      
      return { exitCode: 0, imagePath: filename };
    } catch (err) {
      return { exitCode: 1, error: `Failed to connect to vision worker: ${err}` };
    }
  },
};

const DelegateTaskSchema = RootSchema.extend({
  task_description: z.string().min(10).describe("Detailed description of the task for the sub-agent to perform"),
  context_files: z.array(RelPathSchema).optional().describe("Optional list of files to pre-load into the sub-agent's context"),
});

export function projectRootFromArgs(args: Record<string, unknown>, fallback: string): string {
  const candidate = args.projectRoot;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : fallback;
}

async function runRepoOpFromDelegate(
  request: RepoOperationRequest,
  fallbackProjectRoot: string,
): Promise<RepoOperationResult> {
  try {
    const args = request.args ?? {};
    switch (request.op) {
      case REPO_OPERATION_IDS.search: {
        const result = await searchCodeTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          pattern: String(args.pattern ?? ""),
          dir: typeof args.dir === "string" ? args.dir : ".",
          glob: typeof args.glob === "string" ? args.glob : undefined,
          headLimit: typeof args.headLimit === "number" ? args.headLimit : 100,
        });
        return { ok: true, data: result };
      }
      case REPO_OPERATION_IDS.readRange: {
        const result = await readFileTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          filePath: String(args.filePath ?? ""),
          maxBytes: typeof args.maxBytes === "number" ? args.maxBytes : 200_000,
          startLine: typeof args.startLine === "number" ? args.startLine : undefined,
          endLine: typeof args.endLine === "number" ? args.endLine : undefined,
        });
        return { ok: true, data: result };
      }
      case REPO_OPERATION_IDS.findSymbol: {
        const symbol = String(args.symbol ?? "");
        const result = await searchCodeTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          pattern: symbol,
          dir: typeof args.dir === "string" ? args.dir : ".",
          headLimit: typeof args.headLimit === "number" ? args.headLimit : 50,
          glob: typeof args.glob === "string" ? args.glob : undefined,
        });
        return { ok: true, data: result };
      }
      case REPO_OPERATION_IDS.applyPatch: {
        const mode = typeof args.mode === "string" ? args.mode : "str_replace";
        if (mode === "write_file") {
          const result = await writeFileTool.handler({
            projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
            filePath: String(args.filePath ?? ""),
            content: String(args.content ?? ""),
            createDirs: args.createDirs === true,
          });
          return { ok: true, data: result };
        }
        const result = await strReplaceTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          filePath: String(args.filePath ?? ""),
          oldString: String(args.oldString ?? ""),
          newString: String(args.newString ?? ""),
        });
        return { ok: true, data: result };
      }
      case REPO_OPERATION_IDS.runTests: {
        const result = await runTestTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          preset: typeof args.preset === "string" ? args.preset : "node_npm",
        });
        return { ok: result.ok, data: result, error: result.ok ? undefined : result.summary };
      }
      case REPO_OPERATION_IDS.runLint: {
        const result = await runLintTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          preset: typeof args.preset === "string" ? args.preset : "typescript_eslint",
        });
        return { ok: result.ok, data: result, error: result.ok ? undefined : result.summary };
      }
      case REPO_OPERATION_IDS.gitDiff: {
        const result = await gitDiffTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          staged: args.staged === true,
          filePath: typeof args.filePath === "string" ? args.filePath : undefined,
        });
        return { ok: result.exitCode === 0, data: result, error: result.exitCode === 0 ? undefined : result.stderr };
      }
      case REPO_OPERATION_IDS.listChangedFiles: {
        const result = await gitStatusTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
        });
        if (result.exitCode !== 0) {
          return { ok: false, error: result.stderr };
        }
        const files = result.stdout
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0 && !line.startsWith("## "))
          .map((line) => line.slice(3).trim())
          .filter(Boolean);
        return { ok: true, data: { files } };
      }
      case REPO_OPERATION_IDS.writeDecisionRecord: {
        const result = await writeFileTool.handler({
          projectRoot: projectRootFromArgs(args, fallbackProjectRoot),
          filePath: typeof args.filePath === "string" ? args.filePath : ".synesis/decision-record.json",
          content: JSON.stringify(args.decisionRecord ?? {}, null, 2),
          createDirs: true,
        });
        return { ok: true, data: result };
      }
      default:
        return { ok: false, error: `unknown_repo_op:${request.op}` };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "repo_op_failed",
    };
  }
}

export const delegateTaskTool: McpToolDefinition<
  z.infer<typeof DelegateTaskSchema>,
  { status: string; sub_agent_id?: string; error?: string; trace_id?: string; artifacts?: string[]; final_review?: unknown }
> = {
  name: "delegate_task",
  description: "Run bounded request/response sub-agent orchestration (planner/worker/reviewer) with traceable artifacts.",
  inputSchema: DelegateTaskSchema,
  async handler(input) {
    const traceId = `trace-${Date.now()}`;
    const runtime = new RequestResponseRuntime({
      repoOpsAdapter: new GuardedRepoOpsAdapter(
        (request) => runRepoOpFromDelegate(request, input.projectRoot),
        new Set(DEFAULT_AGENT_ALLOWED_REPO_OPS),
      ),
    });
    const response = await runtime.run({
      traceId,
      objective: input.task_description,
      projectRoot: input.projectRoot,
      availableFiles: input.context_files ?? [],
      initialContextSummary: `delegate_task context files count=${input.context_files?.length ?? 0}`,
      allowFullFileOverride: false,
    });

    if (!response.accepted) {
      return {
        status: `Sub-agent orchestration requires input: ${response.responseSummary}`,
        error: response.userQuestions?.join(" | ") || response.responseSummary,
        trace_id: traceId,
        artifacts: response.artifactIds,
      };
    }

    return {
      status: "Sub-agent request/response orchestration completed.",
      sub_agent_id: `sub-agent-${Date.now()}`,
      trace_id: traceId,
      artifacts: response.artifactIds,
      final_review: response.finalReview,
    };
  },
};

const RepoSearchSchema = RootSchema.extend({
  pattern: z.string().min(1).max(500),
  dir: RelPathSchema.default("."),
  glob: z.string().optional(),
  headLimit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(100),
});

const RepoReadRangeSchema = RootSchema.extend({
  filePath: RelPathSchema,
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(200_000),
});

const RepoFindSymbolSchema = RootSchema.extend({
  symbol: z.string().min(1).max(500),
  dir: RelPathSchema.default("."),
  glob: z.string().optional(),
  headLimit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(50),
});

const RepoApplyPatchSchema = RootSchema.extend({
  filePath: RelPathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
});

const RepoRunPresetSchema = RootSchema.extend({
  preset: z.string().min(1),
});

const RepoGitDiffSchema = RootSchema.extend({
  staged: z.boolean().default(false),
  filePath: RelPathSchema.optional(),
});

const RepoWriteDecisionRecordSchema = RootSchema.extend({
  filePath: RelPathSchema.default(".synesis/decision-record.json"),
  decisionRecord: DecisionRecordSchema,
});

export const repoSearchTool: McpToolDefinition<z.infer<typeof RepoSearchSchema>, { matches: string[]; exitCode: number; stderr: string }> = {
  name: "repo.search",
  description: "Agent-scoped repository search primitive.",
  inputSchema: RepoSearchSchema,
  handler: (input) => searchCodeTool.handler(input),
};

export const repoReadRangeTool: McpToolDefinition<
  z.infer<typeof RepoReadRangeSchema>,
  {
    filePath: string;
    content: string;
    truncated: boolean;
    bytes: number;
    lineRange?: { startLine: number; endLine: number };
  }
> = {
  name: "repo.read_range",
  description: "Agent-scoped bounded file read primitive.",
  inputSchema: RepoReadRangeSchema,
  handler: (input) => readFileTool.handler(input),
};

export const repoFindSymbolTool: McpToolDefinition<z.infer<typeof RepoFindSymbolSchema>, { matches: string[]; exitCode: number; stderr: string }> = {
  name: "repo.find_symbol",
  description: "Agent-scoped symbol lookup primitive.",
  inputSchema: RepoFindSymbolSchema,
  handler: (input) => searchCodeTool.handler({
    projectRoot: input.projectRoot,
    pattern: input.symbol,
    dir: input.dir,
    glob: input.glob,
    headLimit: input.headLimit,
  }),
};

export const repoApplyPatchTool: McpToolDefinition<
  z.infer<typeof RepoApplyPatchSchema>,
  {
    filePath: string;
    replaced: boolean;
    ok: boolean;
    reason: "applied" | "not_found" | "context_mismatch" | "multiple_matches";
    suggestedNextActions: string[];
    contextHint?: string;
  }
> = {
  name: "repo.apply_patch",
  description: "Agent-scoped patch primitive using deterministic string replacement.",
  inputSchema: RepoApplyPatchSchema,
  handler: (input) => strReplaceTool.handler(input),
};

export const repoRunTestsTool: McpToolDefinition<z.infer<typeof RepoRunPresetSchema>, RunPresetResult> = {
  name: "repo.run_tests",
  description: "Agent-scoped test runner primitive.",
  inputSchema: RepoRunPresetSchema,
  handler: (input) => runTestTool.handler(input),
};

export const repoRunLintTool: McpToolDefinition<z.infer<typeof RepoRunPresetSchema>, RunPresetResult> = {
  name: "repo.run_lint",
  description: "Agent-scoped lint runner primitive.",
  inputSchema: RepoRunPresetSchema,
  handler: (input) => runLintTool.handler(input),
};

export const repoGitDiffTool: McpToolDefinition<z.infer<typeof RepoGitDiffSchema>, { exitCode: number; stdout: string; stderr: string }> = {
  name: "repo.git_diff",
  description: "Agent-scoped git diff primitive.",
  inputSchema: RepoGitDiffSchema,
  handler: (input) => gitDiffTool.handler(input),
};

export const repoListChangedFilesTool: McpToolDefinition<
  z.infer<typeof RootSchema>,
  { files: string[]; count: number }
> = {
  name: "repo.list_changed_files",
  description: "Agent-scoped changed file listing primitive.",
  inputSchema: RootSchema,
  async handler(input) {
    const out = await gitStatusTool.handler({ projectRoot: input.projectRoot });
    if (out.exitCode !== 0) return { files: [], count: 0 };
    const files = out.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && !line.startsWith("## "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return { files, count: files.length };
  },
};

export const repoWriteDecisionRecordTool: McpToolDefinition<
  z.infer<typeof RepoWriteDecisionRecordSchema>,
  { filePath: string; bytes: number; written: true }
> = {
  name: "repo.write_decision_record",
  description: "Agent-scoped decision record persistence primitive.",
  inputSchema: RepoWriteDecisionRecordSchema,
  handler: (input) => writeFileTool.handler({
    projectRoot: input.projectRoot,
    filePath: input.filePath,
    content: JSON.stringify(input.decisionRecord, null, 2),
    createDirs: true,
  }),
};

export const strReplaceTool: McpToolDefinition<
  z.infer<typeof StrReplaceSchema>,
  {
    filePath: string;
    replaced: boolean;
    ok: boolean;
    reason: "applied" | "not_found" | "context_mismatch" | "multiple_matches";
    suggestedNextActions: string[];
    contextHint?: string;
  }
> = {
  name: "str_replace",
  description:
    "Apply deterministic single-occurrence string replacement in a file. Prefer this over whole-file rewrites for existing files; returns recovery hints when patching fails.",
  inputSchema: StrReplaceSchema,
  async handler(input) {
    const abs = resolveInsideRoot(input.projectRoot, input.filePath);
    const content = await fs.readFile(abs, "utf8");
    const idx = content.indexOf(input.oldString);
    const secondIdx = idx >= 0 ? content.indexOf(input.oldString, idx + input.oldString.length) : -1;
    if (idx >= 0 && secondIdx >= 0) {
      return {
        filePath: input.filePath,
        replaced: false,
        ok: false,
        reason: "multiple_matches",
        suggestedNextActions: [
          "read_file(filePath=<same file>, startLine=<nearby>, endLine=<nearby+200>)",
          "retry str_replace with a larger unique oldString context (3-8 surrounding lines)",
          "prefer one focused replacement per call",
        ],
      };
    }
    if (idx < 0) {
      const firstOldLine = input.oldString
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0)
        ?? "";
      let contextHint: string | undefined;
      if (firstOldLine.length > 0) {
        const lines = content.split(/\r?\n/);
        const nearbyIdx = lines.findIndex((l) => l.includes(firstOldLine.slice(0, Math.min(80, firstOldLine.length))));
        if (nearbyIdx >= 0) {
          const start = Math.max(0, nearbyIdx - 2);
          const end = Math.min(lines.length, nearbyIdx + 3);
          contextHint = lines.slice(start, end).join("\n");
        }
      }
      return {
        filePath: input.filePath,
        replaced: false,
        ok: false,
        reason: contextHint ? "context_mismatch" : "not_found",
        suggestedNextActions: [
          "search_code(pattern=<target symbol>, dir='.')",
          "read_file(filePath=<same file>, startLine=<nearby>, endLine=<nearby+200>)",
          "retry str_replace with adjusted oldString context",
        ],
        ...(contextHint ? { contextHint } : {}),
      };
    }
    const updated = `${content.slice(0, idx)}${input.newString}${content.slice(idx + input.oldString.length)}`;
    await fs.writeFile(abs, updated, "utf8");
    return {
      filePath: input.filePath,
      replaced: true,
      ok: true,
      reason: "applied",
      suggestedNextActions: [],
    };
  },
};

const SearchCodeSchema = RootSchema.extend({
  pattern: z.string().min(1).max(500),
  dir: RelPathSchema.default("."),
  glob: z.string().optional(),
  headLimit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(100),
});
export const searchCodeTool: McpToolDefinition<
  z.infer<typeof SearchCodeSchema>,
  {
    matches: string[];
    exitCode: number;
    stderr: string;
    noResultsGuidance?: string[];
  }
> = {
  name: "search_code",
  description:
    "Search code with ripgrep under project root (bounded). Use this to locate symbols before read_file; prefer file:line matches over listing entire directories via shell.",
  inputSchema: SearchCodeSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const dir = resolveInsideRoot(root, input.dir);
    const args = ["--line-number", "--no-heading", "--color", "never"];
    if (input.glob) args.push("--glob", input.glob);
    args.push("-m", String(input.headLimit), input.pattern, dir);
    const out = await runCommand(root, "rg", args);
    if (out.exitCode !== 0 && out.stderr.includes("ENOENT")) {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern);
      } catch {
        return { matches: [], exitCode: 2, stderr: "Invalid regex pattern" };
      }
      const files = await walkFilesForSearch(dir, 4);
      const matches: string[] = [];
      for (const f of files) {
        if (matches.length >= input.headLimit) break;
        const content = await fs.readFile(f, "utf8").catch(() => "");
        if (!content) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            matches.push(`${path.relative(root, f)}:${i + 1}:${lines[i]}`);
            if (matches.length >= input.headLimit) break;
          }
        }
      }
      return {
        matches,
        exitCode: matches.length > 0 ? 0 : 1,
        stderr: "",
        ...(matches.length === 0
          ? {
              noResultsGuidance: [
                "Try a partial symbol match or shorter regex.",
                "Broaden dir scope by one level.",
                "Use list_dir first, then re-run search_code with a scoped dir.",
              ],
            }
          : {}),
      };
    }
    const matches = out.stdout.split(/\r?\n/).filter(Boolean).slice(0, input.headLimit);
    return {
      matches,
      exitCode: out.exitCode,
      stderr: out.stderr,
      ...(matches.length === 0
        ? {
            noResultsGuidance: [
              "Try a partial symbol match or shorter regex.",
              "Check spelling/case sensitivity and glob filters.",
              "Use list_dir on the target folder before retrying search_code.",
            ],
          }
        : {}),
    };
  },
};

const RunPresetSchema = RootSchema.extend({
  preset: z.string().min(1),
});

/** Structured result for run_build / run_test / run_lint / format_code (observation contract). */
export interface RunPresetResult {
  preset: string;
  command: string;
  exitCode: number;
  ok: boolean;
  summary: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Heuristic classification + hints for TTY-shaped or stalled CLI output. */
  terminalSignals: TerminalSignals;
  /** Up to 28 lines of compiler/test diagnostics (from shaped output before stream truncation). */
  errorLines: string[];
  /** Optional structured diagnostics for fast patch recovery (tsc/go test/go build patterns). */
  errors: StructuredDiagnostic[];
  /** Suggested recovery actions when ok=false. */
  nextActions: string[];
}

function makeRunnerTool(
  name: string,
  description: string,
  presets: Record<string, [string, ...string[]]>,
): McpToolDefinition<z.infer<typeof RunPresetSchema>, RunPresetResult> {
  return {
    name,
    description,
    inputSchema: RunPresetSchema,
    async handler(input) {
      const preset = presets[input.preset];
      if (!preset) {
        throw new Error(`Unknown preset '${input.preset}'. Allowed: ${Object.keys(presets).join(", ")}`);
      }
      const [cmd, ...args] = preset;
      const full = await runCommand(path.resolve(input.projectRoot), cmd, args);
      const proc = processRunnerStreams(full.stdout, full.stderr);
      const errorLines = extractDiagnosticLines(proc.stderrOut, proc.stdoutOut, 28);
      const errors = extractStructuredErrors(proc.stderrOut, proc.stdoutOut, 16);
      const ok = full.exitCode === 0;
      let summary = ok
        ? `ok exit=0 preset=${input.preset}`
        : `failed exit=${full.exitCode} preset=${input.preset} diagnostics=${errorLines.length}`;
      const termHint = formatTerminalVerificationHint(proc.terminalSignals);
      if (termHint) {
        summary = `${summary}\n${termHint}`;
      }
      const nextActions: string[] = ok
        ? []
        : [
            "read_file(filePath=<reported file>, startLine=<nearby>, endLine=<nearby+200>)",
            "str_replace with minimal fix",
            `rerun ${name}(preset=${input.preset})`,
          ];
      if (proc.terminalSignals.hints.length > 0 && proc.terminalSignals.classification !== "unknown") {
        nextActions.push(proc.terminalSignals.hints[0]!);
      }
      return {
        preset: input.preset,
        command: [cmd, ...args].join(" "),
        exitCode: full.exitCode,
        ok,
        summary,
        stdout: proc.stdoutOut,
        stderr: proc.stderrOut,
        stdoutTruncated: proc.stdoutTruncated,
        stderrTruncated: proc.stderrTruncated,
        terminalSignals: proc.terminalSignals,
        errorLines,
        errors,
        nextActions,
      };
    },
  };
}

const RUNNER_DESC =
  "Allowlisted preset. Blocking policy: if ok=false, do not finalize. Fix diagnostics first, then rerun the same check. Prefer run_lint/run_build before run_test when compile/typecheck is cheap; summary + errorLines are derived from full output.";

export const runTestTool = makeRunnerTool(
  "run_test",
  `Run tests using preset test commands (bounded stdout/stderr + errorLines). ${RUNNER_DESC}`,
  RUN_TEST_PRESETS,
);

export const runBuildTool = makeRunnerTool(
  "run_build",
  `Run compile/build using preset commands (bounded stdout/stderr + errorLines). ${RUNNER_DESC}`,
  RUN_BUILD_PRESETS,
);

export const runLintTool = makeRunnerTool(
  "run_lint",
  `Run lint/static checks using preset commands (bounded stdout/stderr + errorLines). ${RUNNER_DESC}`,
  RUN_LINT_PRESETS,
);

export const formatCodeTool = makeRunnerTool(
  "format_code",
  "Run formatter using allowlisted deterministic command presets (bounded stdout/stderr + errorLines).",
  FORMAT_PRESETS,
);

const GitStatusSchema = RootSchema;
export const gitStatusTool: McpToolDefinition<
  z.infer<typeof GitStatusSchema>,
  { exitCode: number; stdout: string; stderr: string }
> = {
  name: "git_status",
  description: "Run git status --short --branch inside project root.",
  inputSchema: GitStatusSchema,
  async handler(input) {
    return runCommand(path.resolve(input.projectRoot), "git", ["status", "--short", "--branch"]);
  },
};

const GitDiffSchema = RootSchema.extend({
  staged: z.boolean().default(false),
  filePath: RelPathSchema.optional(),
});
export const gitDiffTool: McpToolDefinition<
  z.infer<typeof GitDiffSchema>,
  { exitCode: number; stdout: string; stderr: string }
> = {
  name: "git_diff",
  description: "Run git diff (optionally staged, optionally for one relative file path).",
  inputSchema: GitDiffSchema,
  async handler(input) {
    const args = ["diff"];
    if (input.staged) args.push("--staged");
    if (input.filePath) {
      resolveInsideRoot(input.projectRoot, input.filePath);
      args.push("--", input.filePath);
    }
    return runCommand(path.resolve(input.projectRoot), "git", args);
  },
};

const GitRevParseSchema = RootSchema.extend({
  path: RelPathSchema.optional(),
});
export const gitRevParseTool: McpToolDefinition<
  z.infer<typeof GitRevParseSchema>,
  { isGitRepo: boolean; topLevel: string | null; branch: string | null; detachedHead: boolean }
> = {
  name: "git_rev_parse",
  description: "Read-only git repository preflight: repo presence, top-level, branch, detached head.",
  inputSchema: GitRevParseSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    if (input.path) resolveInsideRoot(root, input.path);
    const repo = await isGitRepo(root);
    if (!repo) return { isGitRepo: false, topLevel: null, branch: null, detachedHead: false };
    const top = await runCommand(root, "git", ["rev-parse", "--show-toplevel"]);
    const branch = await runCommand(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branchText = branch.stdout.trim();
    return {
      isGitRepo: true,
      topLevel: top.exitCode === 0 ? (top.stdout.trim() || root) : root,
      branch: branchText && branchText !== "HEAD" ? branchText : null,
      detachedHead: branchText === "HEAD",
    };
  },
};

const GitBranchInfoSchema = RootSchema;
export const gitBranchInfoTool: McpToolDefinition<
  z.infer<typeof GitBranchInfoSchema>,
  {
    isGitRepo: boolean;
    branch: string | null;
    detachedHead: boolean;
    ahead: number;
    behind: number;
    hasUntracked: boolean;
    dirty: boolean;
  }
> = {
  name: "git_branch_info",
  description: "Read-only branch and working tree summary derived from git status --short --branch.",
  inputSchema: GitBranchInfoSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const repo = await isGitRepo(root);
    if (!repo) {
      return {
        isGitRepo: false,
        branch: null,
        detachedHead: false,
        ahead: 0,
        behind: 0,
        hasUntracked: false,
        dirty: false,
      };
    }
    const status = await runCommand(root, "git", ["status", "--short", "--branch"]);
    const header = status.stdout.split(/\r?\n/).find((l) => l.startsWith("## ")) ?? "";
    const branch = branchFromStatusHeader(status.stdout);
    const ahead = (() => {
      const m = /\bahead (\d+)\b/.exec(header);
      return m?.[1] ? Math.max(0, Math.trunc(Number(m[1]))) : 0;
    })();
    const behind = (() => {
      const m = /\bbehind (\d+)\b/.exec(header);
      return m?.[1] ? Math.max(0, Math.trunc(Number(m[1]))) : 0;
    })();
    const lines = status.stdout.split(/\r?\n/).slice(1).filter(Boolean);
    const hasUntracked = lines.some((l) => l.startsWith("?? "));
    const dirty = lines.length > 0;
    const branchProbe = await runCommand(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const detachedHead = branchProbe.stdout.trim() === "HEAD";
    return { isGitRepo: true, branch, detachedHead, ahead, behind, hasUntracked, dirty };
  },
};

const GitFileStateSchema = RootSchema.extend({
  filePath: RelPathSchema,
});
export const gitFileStateTool: McpToolDefinition<
  z.infer<typeof GitFileStateSchema>,
  { isGitRepo: boolean; filePath: string; statusCode: string | null; tracked: boolean; staged: boolean }
> = {
  name: "git_file_state",
  description: "Read-only file-level git status for one path (XY status, tracked, staged).",
  inputSchema: GitFileStateSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    resolveInsideRoot(root, input.filePath);
    const repo = await isGitRepo(root);
    if (!repo) {
      return { isGitRepo: false, filePath: input.filePath, statusCode: null, tracked: false, staged: false };
    }
    const out = await runCommand(root, "git", ["status", "--porcelain", "--", input.filePath]);
    const line = out.stdout.split(/\r?\n/).find(Boolean) ?? "";
    const statusCode = line ? line.slice(0, 2) : null;
    const tracked = statusCode !== "??";
    const staged = !!statusCode && statusCode[0] !== " " && statusCode[0] !== "?";
    return { isGitRepo: true, filePath: input.filePath, statusCode, tracked, staged };
  },
};

const GitAddGuardedSchema = RootSchema.extend({
  files: z.array(RelPathSchema).min(1).max(200),
  requireCleanWorkingTree: z.boolean().default(false),
});
export const gitAddGuardedTool: McpToolDefinition<
  z.infer<typeof GitAddGuardedSchema>,
  {
    added: string[];
    blocked: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    policyMode: GitPolicyMode;
    repoDetected: boolean;
  }
> = {
  name: "git_add_guarded",
  description: "Stage only explicitly listed non-sensitive relative paths.",
  inputSchema: GitAddGuardedSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const policyMode = gitPolicyModeFromEnv();
    const repoDetected = await isGitRepo(root);
    if (!repoDetected) {
      return {
        added: [],
        blocked: [],
        exitCode: 1,
        stdout: "",
        stderr: "No git repository detected at project root",
        policyMode,
        repoDetected,
      };
    }
    if (policyMode === "enforced" && input.requireCleanWorkingTree) {
      const status = await runCommand(root, "git", ["status", "--porcelain"]);
      const dirtyLines = status.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (dirtyLines.length > 0) {
        return {
          added: [],
          blocked: [],
          exitCode: 1,
          stdout: status.stdout,
          stderr: "Git policy enforced: working tree is not clean",
          policyMode,
          repoDetected,
        };
      }
    }
    const blocked: string[] = [];
    const safe: string[] = [];
    for (const f of input.files) {
      resolveInsideRoot(root, f);
      if (BlockedGitPaths.some((re) => re.test(f))) blocked.push(f);
      else safe.push(f);
    }
    if (safe.length === 0) {
      return {
        added: [],
        blocked,
        exitCode: 1,
        stdout: "",
        stderr: "No safe files to add",
        policyMode,
        repoDetected,
      };
    }
    const out = await runCommand(root, "git", ["add", "--", ...safe]);
    return {
      added: safe,
      blocked,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      policyMode,
      repoDetected,
    };
  },
};

const GitCommitGuardedSchema = RootSchema.extend({
  message: z.string().min(5).max(300),
  files: z.array(RelPathSchema).min(1).max(200).optional(),
  requireStatusCheck: z.boolean().default(true),
  allowDetachedHead: z.boolean().default(false),
});
const RunInSandboxSchema = RootSchema.extend({
  filePath: RelPathSchema,
  language: z.string().min(1).describe("Language of the file (e.g., python, bash, go, javascript)"),
  trivial: z.boolean().default(false).describe("If true, only runs syntax/format checks. If false, runs full linting/execution."),
});

export type RunInSandboxToolResult = {
  exitCode: number;
  lint: unknown;
  execution: unknown;
  error?: string;
  terminal_signals?: TerminalSignals;
};

export const runInSandboxTool: McpToolDefinition<z.infer<typeof RunInSandboxSchema>, RunInSandboxToolResult> = {
  name: "run_in_sandbox",
  description: "Run a single file in the isolated Synesis sandbox. Useful for speculative execution of scripts to capture stdout/stderr safely.",
  inputSchema: RunInSandboxSchema,
  async handler(input): Promise<RunInSandboxToolResult> {
    const abs = resolveInsideRoot(input.projectRoot, input.filePath);
    const code = await fs.readFile(abs, "utf8");
    
    const url = process.env.SYNESIS_SANDBOX_URL || "http://synesis-warm-pool.synesis-sandbox.svc.cluster.local:8080/execute";
    const secret = process.env.SYNESIS_SANDBOX_SECRET || "";

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          language: input.language,
          code,
          filename: path.basename(input.filePath),
          trivial: input.trivial,
        }),
      });

      if (!resp.ok) {
        return { exitCode: 1, lint: null, execution: null, error: `Sandbox returned HTTP ${resp.status}: ${await resp.text()}` };
      }

      const result = (await resp.json()) as Record<string, unknown>;
      return applyTerminalToSandboxResult(result) as RunInSandboxToolResult;
    } catch (err) {
      return { exitCode: 1, lint: null, execution: null, error: `Failed to connect to sandbox: ${err}` };
    }
  },
};

export const gitCommitGuardedTool: McpToolDefinition<
  z.infer<typeof GitCommitGuardedSchema>,
  {
    committed: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    branch: string | null;
    detachedHead: boolean;
    stagedCount: number;
    policyMode: GitPolicyMode;
  }
> = {
  name: "git_commit_guarded",
  description: "Guarded git commit: optional safe add of files then commit with provided message.",
  inputSchema: GitCommitGuardedSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const policyMode = gitPolicyModeFromEnv();
    const repoDetected = await isGitRepo(root);
    if (!repoDetected) {
      return {
        committed: false,
        exitCode: 1,
        stdout: "",
        stderr: "No git repository detected at project root",
        branch: null,
        detachedHead: false,
        stagedCount: 0,
        policyMode,
      };
    }
    const branchProbe = await runCommand(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branchText = branchProbe.stdout.trim();
    const detachedHead = branchText === "HEAD";
    const branch = detachedHead ? null : (branchText || null);
    if (policyMode === "enforced" && detachedHead && !input.allowDetachedHead) {
      return {
        committed: false,
        exitCode: 1,
        stdout: branchProbe.stdout,
        stderr: "Git policy enforced: refusing commit on detached HEAD",
        branch,
        detachedHead,
        stagedCount: 0,
        policyMode,
      };
    }
    if (input.requireStatusCheck) {
      const status = await runCommand(root, "git", ["status", "--short", "--branch"]);
      if (status.exitCode !== 0) {
        return {
          committed: false,
          exitCode: status.exitCode,
          stdout: status.stdout,
          stderr: status.stderr || "git status preflight failed",
          branch,
          detachedHead,
          stagedCount: 0,
          policyMode,
        };
      }
    }
    if (input.files?.length) {
      const add = await gitAddGuardedTool.handler({
        projectRoot: root,
        files: input.files,
        requireCleanWorkingTree: false,
      });
      if (add.exitCode !== 0) {
        return {
          committed: false,
          exitCode: add.exitCode,
          stdout: add.stdout,
          stderr: add.stderr,
          branch,
          detachedHead,
          stagedCount: 0,
          policyMode,
        };
      }
    }
    const staged = await listStagedFiles(root);
    if (staged.length === 0) {
      return {
        committed: false,
        exitCode: 1,
        stdout: "",
        stderr: "No staged changes to commit",
        branch,
        detachedHead,
        stagedCount: 0,
        policyMode,
      };
    }
    const blockedStaged = staged.filter((f) => BlockedGitPaths.some((re) => re.test(f)));
    if (blockedStaged.length > 0) {
      return {
        committed: false,
        exitCode: 1,
        stdout: blockedStaged.join("\n"),
        stderr: "Blocked staged paths detected; unstage sensitive files before committing",
        branch,
        detachedHead,
        stagedCount: staged.length,
        policyMode,
      };
    }
    const out = await runCommand(root, "git", ["commit", "-m", input.message]);
    return {
      committed: out.exitCode === 0,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      branch,
      detachedHead,
      stagedCount: staged.length,
      policyMode,
    };
  },
};
