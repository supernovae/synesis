import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { HarnessTesterResolvedTask, HarnessTesterSuiteSpec, HarnessTesterTaskSpec } from "./types.js";

export async function loadHarnessTesterTask(taskPath: string): Promise<HarnessTesterResolvedTask> {
  const absoluteTaskPath = resolve(taskPath);
  const raw = JSON.parse(await readFile(absoluteTaskPath, "utf-8")) as Partial<HarnessTesterTaskSpec>;
  validateTask(raw, absoluteTaskPath);
  const fixturePath = isAbsolute(raw.fixture) ? raw.fixture : resolve(dirname(absoluteTaskPath), raw.fixture);
  return {
    ...raw,
    taskPath: absoluteTaskPath,
    fixturePath,
  };
}

export async function loadHarnessTesterSuite(suitePath: string): Promise<HarnessTesterSuiteSpec & { suitePath: string }> {
  const absoluteSuitePath = resolve(suitePath);
  const raw = JSON.parse(await readFile(absoluteSuitePath, "utf-8")) as Partial<HarnessTesterSuiteSpec>;
  if (!raw.id || typeof raw.id !== "string") throw new Error(`Harness tester suite ${suitePath} is missing string id`);
  if (!raw.name || typeof raw.name !== "string") throw new Error(`Harness tester suite ${suitePath} is missing string name`);
  if (!Array.isArray(raw.tasks) || raw.tasks.some((task) => typeof task !== "string")) {
    throw new Error(`Harness tester suite ${suitePath} must define tasks as string paths`);
  }
  return {
    id: raw.id,
    name: raw.name,
    tasks: raw.tasks.map((task) => (isAbsolute(task) ? task : resolve(dirname(absoluteSuitePath), task))),
    defaults: raw.defaults,
    suitePath: absoluteSuitePath,
  };
}

function validateTask(raw: Partial<HarnessTesterTaskSpec>, taskPath: string): asserts raw is HarnessTesterTaskSpec {
  if (!raw.id || typeof raw.id !== "string") throw new Error(`Harness tester task ${taskPath} is missing string id`);
  if (!raw.name || typeof raw.name !== "string") throw new Error(`Harness tester task ${taskPath} is missing string name`);
  if (!raw.prompt || typeof raw.prompt !== "string") throw new Error(`Harness tester task ${taskPath} is missing string prompt`);
  if (!raw.fixture || typeof raw.fixture !== "string") throw new Error(`Harness tester task ${taskPath} is missing string fixture`);
  validateStringArray(raw.setup, "setup", taskPath);
  validateStringArray(raw.validate, "validate", taskPath);
  validateStringArray(raw.expected_changed, "expected_changed", taskPath);
  validateStringArray(raw.forbidden_changed, "forbidden_changed", taskPath);
  if (raw.timeout_seconds !== undefined && (!Number.isFinite(raw.timeout_seconds) || raw.timeout_seconds <= 0)) {
    throw new Error(`Harness tester task ${taskPath} has invalid timeout_seconds`);
  }
}

function validateStringArray(value: unknown, field: string, taskPath: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Harness tester task ${taskPath} field ${field} must be a string array`);
  }
}
