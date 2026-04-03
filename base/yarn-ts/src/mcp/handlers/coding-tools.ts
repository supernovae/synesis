import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpToolDefinition } from "../tool-registry.js";

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
  node_npm: ["npm", "test"],
  node_pnpm: ["pnpm", "test"],
  node_yarn: ["yarn", "test"],
  rust: ["cargo", "test"],
};

const RUN_BUILD_PRESETS: Record<string, [string, ...string[]]> = {
  go: ["go", "build", "./..."],
  python: ["python", "-m", "compileall", "."],
  node_npm: ["npm", "run", "build"],
  node_pnpm: ["pnpm", "build"],
  node_yarn: ["yarn", "build"],
  rust: ["cargo", "build"],
};

const RUN_LINT_PRESETS: Record<string, [string, ...string[]]> = {
  go: ["go", "vet", "./..."],
  python: ["ruff", "check", "."],
  node_npm: ["npm", "run", "lint"],
  node_pnpm: ["pnpm", "lint"],
  node_yarn: ["yarn", "lint"],
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
});
export const readFileTool: McpToolDefinition<
  z.infer<typeof ReadFileSchema>,
  { filePath: string; content: string; truncated: boolean; bytes: number }
> = {
  name: "read_file",
  description: "Read a UTF-8 file under project root with byte limits.",
  inputSchema: ReadFileSchema,
  async handler(input) {
    const abs = resolveInsideRoot(input.projectRoot, input.filePath);
    const data = await fs.readFile(abs);
    const truncated = data.byteLength > input.maxBytes;
    const used = truncated ? data.subarray(0, input.maxBytes) : data;
    return {
      filePath: input.filePath,
      content: used.toString("utf8"),
      truncated,
      bytes: used.byteLength,
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

const ApplyPatchSchema = RootSchema.extend({
  filePath: RelPathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
});
export const applyPatchTool: McpToolDefinition<
  z.infer<typeof ApplyPatchSchema>,
  { filePath: string; replaced: boolean }
> = {
  name: "apply_patch",
  description: "Apply deterministic single-occurrence string replacement in a file.",
  inputSchema: ApplyPatchSchema,
  async handler(input) {
    const abs = resolveInsideRoot(input.projectRoot, input.filePath);
    const content = await fs.readFile(abs, "utf8");
    const idx = content.indexOf(input.oldString);
    if (idx < 0) return { filePath: input.filePath, replaced: false };
    const updated = `${content.slice(0, idx)}${input.newString}${content.slice(idx + input.oldString.length)}`;
    await fs.writeFile(abs, updated, "utf8");
    return { filePath: input.filePath, replaced: true };
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
  description: "Search code with ripgrep under project root using bounded output.",
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

function makeRunnerTool(
  name: string,
  description: string,
  presets: Record<string, [string, ...string[]]>,
): McpToolDefinition<z.infer<typeof RunPresetSchema>, { preset: string; command: string; exitCode: number; stdout: string; stderr: string }> {
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
      const result = await runCommand(path.resolve(input.projectRoot), cmd, args);
      return {
        preset: input.preset,
        command: [cmd, ...args].join(" "),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

export const runTestTool = makeRunnerTool(
  "run_test",
  "Run tests using allowlisted deterministic command presets.",
  RUN_TEST_PRESETS,
);

export const runBuildTool = makeRunnerTool(
  "run_build",
  "Run build using allowlisted deterministic command presets.",
  RUN_BUILD_PRESETS,
);

export const runLintTool = makeRunnerTool(
  "run_lint",
  "Run lint/check using allowlisted deterministic command presets.",
  RUN_LINT_PRESETS,
);

export const formatCodeTool = makeRunnerTool(
  "format_code",
  "Run formatter using allowlisted deterministic command presets.",
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

const GitAddGuardedSchema = RootSchema.extend({
  files: z.array(RelPathSchema).min(1).max(200),
});
export const gitAddGuardedTool: McpToolDefinition<
  z.infer<typeof GitAddGuardedSchema>,
  { added: string[]; blocked: string[]; exitCode: number; stdout: string; stderr: string }
> = {
  name: "git_add_guarded",
  description: "Stage only explicitly listed non-sensitive relative paths.",
  inputSchema: GitAddGuardedSchema,
  async handler(input) {
    const blocked: string[] = [];
    const safe: string[] = [];
    for (const f of input.files) {
      resolveInsideRoot(input.projectRoot, f);
      if (BlockedGitPaths.some((re) => re.test(f))) blocked.push(f);
      else safe.push(f);
    }
    if (safe.length === 0) {
      return { added: [], blocked, exitCode: 1, stdout: "", stderr: "No safe files to add" };
    }
    const out = await runCommand(path.resolve(input.projectRoot), "git", ["add", "--", ...safe]);
    return { added: safe, blocked, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr };
  },
};

const GitCommitGuardedSchema = RootSchema.extend({
  message: z.string().min(5).max(300),
  files: z.array(RelPathSchema).min(1).max(200).optional(),
});
export const gitCommitGuardedTool: McpToolDefinition<
  z.infer<typeof GitCommitGuardedSchema>,
  { committed: boolean; exitCode: number; stdout: string; stderr: string }
> = {
  name: "git_commit_guarded",
  description: "Guarded git commit: optional safe add of files then commit with provided message.",
  inputSchema: GitCommitGuardedSchema,
  async handler(input) {
    const root = path.resolve(input.projectRoot);
    if (input.files?.length) {
      const add = await gitAddGuardedTool.handler({ projectRoot: root, files: input.files });
      if (add.exitCode !== 0) {
        return { committed: false, exitCode: add.exitCode, stdout: add.stdout, stderr: add.stderr };
      }
    }
    const out = await runCommand(root, "git", ["commit", "-m", input.message]);
    return { committed: out.exitCode === 0, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr };
  },
};

