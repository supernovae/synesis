import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureWorkspaceSnapshot,
  classifyHarnessTesterRun,
  createOpenCodeHarnessAdapter,
  loadHarnessBenchmarkTask,
  loadHarnessTesterSuite,
  loadHarnessTesterTask,
  prepareHarnessWorkspace,
  renderHarnessTesterSummaryTable,
  runHarnessTesterCommand,
  runHarnessTesterTask,
  type HarnessTesterAdapter,
  type HarnessTesterApiTraceSummary,
} from "../src/eval/harness-tester/index.js";

const pythonTaskPath = "tests/fixtures/harness-tester/tasks/simple-python-bugfix.json";

describe("harness tester", () => {
  it("loads task and suite fixtures", async () => {
    const task = await loadHarnessTesterTask(pythonTaskPath);
    const suite = await loadHarnessTesterSuite("tests/fixtures/harness-tester/suites/language-core.json");

    expect(task.id).toBe("simple-python-bugfix-001");
    expect(task.fixturePath).toContain("simple-python-bugfix");
    expect(suite.tasks).toHaveLength(3);
  });

  it("loads benchmark task specs through first-class adapters", async () => {
    const sweTask = await loadHarnessBenchmarkTask("tests/fixtures/harness-tester/benchmarks/swe-bench-local-python.json");
    const xlamTask = await loadHarnessBenchmarkTask("tests/fixtures/harness-tester/benchmarks/xlam-local-tool-use.json");
    const humanEvalTask = await loadHarnessBenchmarkTask("tests/fixtures/harness-tester/benchmarks/humaneval-local-add.json");

    expect(sweTask.benchmark).toBe("swe-bench");
    expect(sweTask.validate).toEqual(["python -m pytest -q"]);
    expect(xlamTask.benchmark_metadata?.expected_tool_names).toEqual(["Edit", "Bash"]);
    expect(humanEvalTask.benchmark_metadata?.entry_point).toBe("add");
  });

  it("creates an isolated workspace and captures git diff", async () => {
    const task = await loadHarnessTesterTask(pythonTaskPath);
    const prepared = await prepareHarnessWorkspace({ task, runId: "workspace-test" });
    try {
      await writeFile(join(prepared.workspacePath, "example_pkg/math_utils.py"), "def add(a: int, b: int) -> int:\n    return a + b\n", "utf-8");
      const snapshot = await captureWorkspaceSnapshot(prepared.workspacePath);

      expect(snapshot.gitAvailable).toBe(true);
      expect(snapshot.changedFiles).toContain("example_pkg/math_utils.py");
      expect(snapshot.diff).toContain("return a + b");
    } finally {
      await rm(prepared.workspacePath, { recursive: true, force: true });
    }
  });

  it("runs validators and emits a passing report with a fake harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "synesis-harness-tester-test-"));
    const task = await loadHarnessTesterTask(pythonTaskPath);
    const fakeHarness: HarnessTesterAdapter = {
      name: "fake-opencode",
      buildCommand(input) {
        return {
          command: "node -e \"require('fs').writeFileSync('example_pkg/math_utils.py', 'def add(a: int, b: int) -> int:\\n    return a + b\\n')\"",
          cwd: input.workspacePath,
          timeoutMs: 10_000,
          env: {},
        };
      },
    };
    try {
      const report = await runHarnessTesterTask({
        task: {
          ...task,
          validate: [
            "node -e \"const fs=require('fs'); if (!fs.readFileSync('example_pkg/math_utils.py','utf8').includes('return a + b')) process.exit(1)\"",
          ],
        },
        harness: fakeHarness,
        model: "fake-model",
        apiBaseUrl: "http://localhost:8000/v1",
        artifactsRoot: join(root, "artifacts"),
        workRoot: join(root, "work"),
        keepSuccessfulArtifacts: true,
      });

      expect(report.status).toBe("pass");
      expect(report.benchmark).toBe("harness-task");
      expect(report.normalized_scores.task_success).toBe(1);
      expect(report.changed_files).toEqual(["example_pkg/math_utils.py"]);
      expect(renderHarnessTesterSummaryTable([report])).toContain("simple-python-bugfix-001");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("constructs OpenCode commands with API and run metadata", async () => {
    const task = await loadHarnessTesterTask(pythonTaskPath);
    const adapter = createOpenCodeHarnessAdapter();
    const command = adapter.buildCommand({
      task,
      runId: "run-123",
      sessionKey: "harness-tester-run-123",
      workspacePath: "/tmp/ws",
      promptFilePath: "/tmp/ws/.synesis-harness-tester/prompt.txt",
      model: "qwen3-coder",
      apiBaseUrl: "http://localhost:8000/v1",
      apiKey: "test-key",
    });

    expect(command.command).toContain("opencode run --model qwen3-coder");
    expect(command.command).toContain("--session harness-tester-run-123");
    expect(command.env?.OPENAI_BASE_URL).toBe("http://localhost:8000/v1");
    expect(command.env?.SYNESIS_HARNESS_RUN_ID).toBe("run-123");
  });

  it("classifies validation, path, and schema failures with ownership", async () => {
    const task = await loadHarnessTesterTask(pythonTaskPath);
    const apiTrace: HarnessTesterApiTraceSummary = {
      available: true,
      sessionKey: "s",
      eventCount: 1,
      fatalErrors: 0,
      schemaErrors: 1,
      toolErrors: 0,
    };
    const signals = classifyHarnessTesterRun({
      task,
      setupResults: [],
      harnessResult: {
        command: "opencode run",
        cwd: "/tmp/ws",
        exitCode: 0,
        timedOut: false,
        stdout: "File not found: /home/byron/src/test/src/test/taskpulse/app/main.py\nSchemaError(Expected array)",
        stderr: "",
        durationMs: 1,
      },
      validationResults: [{
        command: "pytest -q",
        cwd: "/tmp/ws",
        exitCode: 1,
        timedOut: false,
        stdout: "failed",
        stderr: "",
        durationMs: 1,
      }],
      workspace: {
        workspacePath: "/tmp/ws",
        gitAvailable: true,
        changedFiles: [],
        diff: "",
        diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      },
      apiTrace,
    });

    expect(signals.map((signal) => signal.flag)).toEqual(
      expect.arrayContaining(["validation_failed", "cwd_path_confusion", "api_schema_error", "no_files_changed"]),
    );
    expect(signals.find((signal) => signal.flag === "api_schema_error")?.owner).toBe("upper_harness");
  });

  it("captures command pass/fail evidence", async () => {
    const pass = await runHarnessTesterCommand({
      command: "node -e \"console.log('ok')\"",
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    const fail = await runHarnessTesterCommand({
      command: "node -e \"process.exit(7)\"",
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(pass.exitCode).toBe(0);
    expect(pass.stdout).toContain("ok");
    expect(fail.exitCode).toBe(7);
  });
});
