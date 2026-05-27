import { dirname, isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { HarnessBenchmarkKind, HarnessTesterResolvedTask, HarnessTesterTaskSpec } from "./types.js";

export interface HarnessBenchmarkTaskSpec {
  benchmark: Exclude<HarnessBenchmarkKind, "harness-task">;
  id: string;
  name: string;
  prompt?: string;
  fixture: string;
  setup?: string[];
  validate?: string[];
  expected_changed?: string[];
  forbidden_changed?: string[];
  timeout_seconds?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  swe_bench?: {
    repo?: string;
    issue?: string;
    test_command?: string;
    patch_files?: string[];
  };
  xlam?: {
    tool_schemas?: unknown[];
    expected_tool_names?: string[];
  };
  humaneval?: {
    entry_point?: string;
    tests?: string;
  };
  mt_bench?: {
    category?: string;
    reference?: string;
  };
  alpacaeval?: {
    instruction?: string;
    reference?: string;
  };
  toxigen?: {
    target_group?: string;
    safety_policy?: string;
  };
}

export interface HarnessBenchmarkAdapter {
  benchmark: Exclude<HarnessBenchmarkKind, "harness-task">;
  toTask(spec: HarnessBenchmarkTaskSpec, specPath: string): HarnessTesterResolvedTask;
}

export async function loadHarnessBenchmarkTask(path: string): Promise<HarnessTesterResolvedTask> {
  const absolutePath = resolve(path);
  const spec = JSON.parse(await readFile(absolutePath, "utf-8")) as Partial<HarnessBenchmarkTaskSpec>;
  validateBenchmarkSpec(spec, absolutePath);
  return getBenchmarkAdapter(spec.benchmark).toTask(spec, absolutePath);
}

export function getBenchmarkAdapter(benchmark: Exclude<HarnessBenchmarkKind, "harness-task">): HarnessBenchmarkAdapter {
  switch (benchmark) {
    case "swe-bench":
      return sweBenchAdapter;
    case "xlam":
      return xlamAdapter;
    case "humaneval":
      return humanEvalAdapter;
    case "mt-bench":
      return promptOnlyAdapter("mt-bench");
    case "alpacaeval":
      return promptOnlyAdapter("alpacaeval");
    case "toxigen":
      return promptOnlyAdapter("toxigen");
  }
}

const sweBenchAdapter: HarnessBenchmarkAdapter = {
  benchmark: "swe-bench",
  toTask(spec, specPath) {
    const testCommand = spec.swe_bench?.test_command;
    return buildResolvedBenchmarkTask(spec, specPath, {
      prompt: spec.prompt ?? [
        `Resolve this SWE-bench-style issue: ${spec.name}`,
        spec.swe_bench?.issue ?? "",
        "Make the smallest source change that satisfies the failing tests.",
      ].filter(Boolean).join("\n\n"),
      validate: spec.validate ?? (testCommand ? [testCommand] : []),
      expected_changed: spec.expected_changed ?? spec.swe_bench?.patch_files,
      tags: ["swe-bench", ...(spec.tags ?? [])],
    });
  },
};

const xlamAdapter: HarnessBenchmarkAdapter = {
  benchmark: "xlam",
  toTask(spec, specPath) {
    return buildResolvedBenchmarkTask(spec, specPath, {
      prompt: spec.prompt ?? [
        "Complete this xLAM-style tool-use task using the available developer harness tools.",
        `Expected tool names: ${(spec.xlam?.expected_tool_names ?? []).join(", ") || "not specified"}`,
      ].join("\n\n"),
      tags: ["xlam", "tool-use", ...(spec.tags ?? [])],
      benchmark_metadata: {
        ...spec.metadata,
        tool_schemas: spec.xlam?.tool_schemas ?? [],
        expected_tool_names: spec.xlam?.expected_tool_names ?? [],
      },
    });
  },
};

const humanEvalAdapter: HarnessBenchmarkAdapter = {
  benchmark: "humaneval",
  toTask(spec, specPath) {
    return buildResolvedBenchmarkTask(spec, specPath, {
      prompt: spec.prompt ?? `Implement the HumanEval-style function ${spec.humaneval?.entry_point ?? "entry_point"} and pass the tests.`,
      tags: ["humaneval", "code-generation", ...(spec.tags ?? [])],
      benchmark_metadata: {
        ...spec.metadata,
        entry_point: spec.humaneval?.entry_point,
      },
    });
  },
};

function promptOnlyAdapter(benchmark: Exclude<HarnessBenchmarkKind, "harness-task" | "swe-bench" | "xlam" | "humaneval">): HarnessBenchmarkAdapter {
  return {
    benchmark,
    toTask(spec, specPath) {
      return buildResolvedBenchmarkTask(spec, specPath, {
        prompt: spec.prompt ?? spec.name,
        tags: [benchmark, ...(spec.tags ?? [])],
      });
    },
  };
}

function buildResolvedBenchmarkTask(
  spec: HarnessBenchmarkTaskSpec,
  specPath: string,
  overrides: Partial<HarnessTesterTaskSpec>,
): HarnessTesterResolvedTask {
  const task: HarnessTesterTaskSpec = {
    id: spec.id,
    name: spec.name,
    prompt: overrides.prompt ?? spec.prompt ?? spec.name,
    fixture: spec.fixture,
    benchmark: spec.benchmark,
    benchmark_metadata: {
      ...spec.metadata,
      ...overrides.benchmark_metadata,
      source_spec: specPath,
    },
    setup: overrides.setup ?? spec.setup,
    validate: overrides.validate ?? spec.validate,
    expected_changed: overrides.expected_changed ?? spec.expected_changed,
    forbidden_changed: overrides.forbidden_changed ?? spec.forbidden_changed,
    timeout_seconds: overrides.timeout_seconds ?? spec.timeout_seconds,
    tags: overrides.tags ?? spec.tags,
  };
  return {
    ...task,
    taskPath: specPath,
    fixturePath: isAbsolute(task.fixture) ? task.fixture : resolve(dirname(specPath), task.fixture),
  };
}

function validateBenchmarkSpec(
  spec: Partial<HarnessBenchmarkTaskSpec>,
  path: string,
): asserts spec is HarnessBenchmarkTaskSpec {
  if (!spec.benchmark) throw new Error(`Benchmark task ${path} is missing benchmark`);
  if (!spec.id || typeof spec.id !== "string") throw new Error(`Benchmark task ${path} is missing string id`);
  if (!spec.name || typeof spec.name !== "string") throw new Error(`Benchmark task ${path} is missing string name`);
  if (!spec.fixture || typeof spec.fixture !== "string") throw new Error(`Benchmark task ${path} is missing string fixture`);
}
