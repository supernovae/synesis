import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyHarnessMatrixFailure,
  expandHarnessMatrix,
  loadHarnessMatrixSpec,
  redactEnv,
  redactSecrets,
  renderHarnessMatrixMarkdown,
  runHarnessMatrix,
  validateHarnessMatrixSpec,
  type HarnessMatrixSpec,
} from "../src/eval/harness-matrix.js";
import type { HarnessLabRiskSignal } from "../src/eval/harness-lab.js";

const fixturePath = "tests/fixtures/harness-matrix/dry-run-openai-compatible.json";

describe("harness matrix", () => {
  it("loads and expands a dry-run matrix schema", async () => {
    const spec = await loadHarnessMatrixSpec(fixturePath);
    const expanded = await expandHarnessMatrix(spec);

    expect(spec.name).toBe("dry-run-openai-compatible-lower-harness");
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.task.id).toBe("rust-workspace-plan-build");
    expect(expanded[0]!.harness.profile).toBe("raw-openai");
    expect(expanded[0]!.model.alias).toBe("Core");
  });

  it("rejects incomplete matrix schema", () => {
    expect(() => validateHarnessMatrixSpec({ name: "bad", tasks: [], harnesses: [], models: [] }))
      .toThrow("must define at least one task");
  });

  it("runs dry-run without shell invocation and writes useful artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "synesis-harness-matrix-test-"));
    const spec = await loadHarnessMatrixSpec(fixturePath);
    try {
      const result = await runHarnessMatrix(spec, {
        dryRun: true,
        artifactsRoot: join(root, "artifacts"),
      });

      expect(result.dryRun).toBe(true);
      expect(result.summary.total).toBe(1);
      expect(result.cases[0]!.stdoutExcerpt).toBe("");
      expect(result.cases[0]!.command.command).toBe("node");
      expect(result.cases[0]!.command.args.join(" ")).toContain("Core");
      expect(result.cases[0]!.command.args.join(" ")).toContain("http://localhost:8000/v1");
      expect(result.cases[0]!.command.env.OPENAI_API_KEY).toBe("<redacted>");
      expect(result.cases[0]!.command.env.OPENAI_BASE_URL).toBe("http://localhost:8000/v1");
      expect(result.cases[0]!.artifactDir).toBeDefined();
      const commandJson = await readFile(join(result.cases[0]!.artifactDir!, "command.json"), "utf-8");
      expect(commandJson).toContain("\"OPENAI_API_KEY\": \"<redacted>\"");
      expect(renderHarnessMatrixMarkdown(result)).toContain("Harness Matrix");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts secrets in env, command strings, and output excerpts", () => {
    const env = {
      OPENAI_API_KEY: "syn-abcdefghijklmnopqrstuvwxyz123456",
      NORMAL_VALUE: "visible",
    };

    expect(redactEnv(env)).toEqual({
      OPENAI_API_KEY: "<redacted>",
      NORMAL_VALUE: "visible",
    });
    expect(redactSecrets("Authorization: Bearer syn-abcdefghijklmnopqrstuvwxyz123456", env))
      .toBe("Authorization: Bearer <redacted>");
  });

  it("attributes forbidden governor pause as governor false positive", () => {
    const result = classifyHarnessMatrixFailure([
      signal("governor_pause", "warning"),
    ], false);

    expect(result.category).toBe("governor_false_positive");
    expect(result.owner).toBe("governor");
    expect(result.promotion).toBe("offline-governor-replay-fixture");
  });

  it("does not fail allowed governor pause as false positive", () => {
    const result = classifyHarnessMatrixFailure([
      signal("governor_pause", "warning"),
    ], true);

    expect(result.category).toBe("unknown");
    expect(result.promotion).toBe("none");
  });

  it.each([
    ["path_confusion", "path_cwd_confusion", "model", "harness-flow-contract"],
    ["invalid_tool_arguments", "tool_schema_mismatch", "tool_schema", "harness-adapter-regression"],
    ["task_reset", "task_state_reset", "model", "harness-flow-contract"],
    ["verification_churn", "verification_churn", "model", "offline-governor-replay-fixture"],
    ["discovery_churn", "discovery_churn", "model", "offline-governor-replay-fixture"],
    ["no_completion_signal", "missing_completion_signal", "model", "eval-gym-scenario"],
  ] as const)("attributes %s", (kind, category, owner, promotion) => {
    const result = classifyHarnessMatrixFailure([signal(kind, "error")], false);
    expect(result.category).toBe(category);
    expect(result.owner).toBe(owner);
    expect(result.promotion).toBe(promotion);
  });

  it("expands explicit cases with rounds", async () => {
    const spec: HarnessMatrixSpec = {
      name: "explicit",
      defaults: { rounds: 2, apiBaseUrl: "http://localhost:8000/v1" },
      tasks: [{ id: "task", prompt: "Do work" }],
      harnesses: [{ id: "opencode", command: "opencode", args: ["run", "--model", "{model}"] }],
      models: [{ id: "model-a", alias: "Core" }],
      cases: [{ id: "case", task: "task", harness: "opencode", model: "model-a" }],
    };

    const expanded = await expandHarnessMatrix(spec);
    expect(expanded.map((item) => item.id)).toEqual(["case-r1", "case-r2"]);
  });
});

function signal(kind: HarnessLabRiskSignal["kind"], severity: HarnessLabRiskSignal["severity"]): HarnessLabRiskSignal {
  return {
    kind,
    severity,
    detail: kind,
  };
}
