import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpToolDefinition } from "../tool-registry.js";
import {
  extractDiagnosticLines,
  extractStructuredErrors,
  MAX_STREAM_CHARS,
  truncateStream,
  type StructuredDiagnostic,
} from "./command-diagnostics.js";

const execFileAsync = promisify(execFile);

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
      env: process.env,
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
  { entries: string[]; count: number; truncated: boolean }
> = {
  name: "list_dir",
  description: "List directory entries under project root with bounded recursion.",
  inputSchema: ListDirSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    const dir = resolveInsideRoot(root, input.dir);
    const entries = await walkDir(dir, input.maxDepth, input.includeHidden);
    return { entries: entries.slice(0, MAX_LIST_ENTRIES), count: entries.length, truncated: entries.length >= MAX_LIST_ENTRIES };
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

export const delegateTaskTool: McpToolDefinition<
  z.infer<typeof DelegateTaskSchema>,
  { status: string; sub_agent_id?: string; error?: string }
> = {
  name: "delegate_task",
  description: "Spawn a parallel sub-agent to perform an isolated task (e.g., massive architectural exploration or reading multiple files). The sub-agent will run asynchronously.",
  inputSchema: DelegateTaskSchema,
  async handler(input) {
    // In a full implementation, this would call the Synesis API to spawn a new yarn-ts session
    // and return the session ID. For now, we return a mock success.
    const subAgentId = `sub-agent-${Date.now()}`;
    return {
      status: "Sub-agent spawned successfully. It will report back when finished.",
      sub_agent_id: subAgentId,
    };
  },
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
  { matches: string[]; exitCode: number; stderr: string }
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
      const re = new RegExp(input.pattern);
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
      return { matches, exitCode: matches.length > 0 ? 0 : 1, stderr: "" };
    }
    return {
      matches: out.stdout.split(/\r?\n/).filter(Boolean).slice(0, input.headLimit),
      exitCode: out.exitCode,
      stderr: out.stderr,
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
  /** Up to 28 lines of compiler/test diagnostics (from full output before stream truncation). */
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
      const errorLines = extractDiagnosticLines(full.stderr, full.stdout, 28);
      const errors = extractStructuredErrors(full.stderr, full.stdout, 16);
      const out = truncateStream(full.stdout, MAX_STREAM_CHARS);
      const err = truncateStream(full.stderr, MAX_STREAM_CHARS);
      const ok = full.exitCode === 0;
      const summary = ok
        ? `ok exit=0 preset=${input.preset}`
        : `failed exit=${full.exitCode} preset=${input.preset} diagnostics=${errorLines.length}`;
      return {
        preset: input.preset,
        command: [cmd, ...args].join(" "),
        exitCode: full.exitCode,
        ok,
        summary,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        errorLines,
        errors,
        nextActions: ok
          ? []
          : [
              "read_file(filePath=<reported file>, startLine=<nearby>, endLine=<nearby+200>)",
              "str_replace with minimal fix",
              `rerun ${name}(preset=${input.preset})`,
            ],
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

export const runInSandboxTool: McpToolDefinition<
  z.infer<typeof RunInSandboxSchema>,
  { exitCode: number; lint: any; execution: any; error?: string }
> = {
  name: "run_in_sandbox",
  description: "Run a single file in the isolated Synesis sandbox. Useful for speculative execution of scripts to capture stdout/stderr safely.",
  inputSchema: RunInSandboxSchema,
  async handler(input) {
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

      const result = await resp.json();
      return result as any;
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

