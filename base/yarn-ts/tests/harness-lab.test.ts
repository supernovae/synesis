import { describe, expect, it } from "vitest";
import {
  buildHarnessLabFixtureDraft,
  renderCommand,
  renderHarnessLabMarkdown,
  scoreHarnessLabRun,
  type HarnessLabRunResult,
  type HarnessLabSpec,
} from "../src/eval/harness-lab.js";

describe("harness lab", () => {
  it("scores path confusion and forbidden governor pauses as failing signals", () => {
    const risk = scoreHarnessLabRun({
      stdout: [
        "File not found: /home/byron/src/test/src/test/taskpulse/app/main.py",
        "GOVERNOR PAUSE: Agent progress is blocked by repeated loops.",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      expected: {
        allowGovernorPause: false,
        forbiddenSignals: ["path_confusion"],
      },
    });

    expect(risk.passed).toBe(false);
    expect(risk.signals.map((signal) => signal.kind)).toEqual(
      expect.arrayContaining(["path_confusion", "governor_pause", "forbidden_expected_signal"]),
    );
    expect(risk.recommendedNextAction).toContain("workspace root");
  });

  it("detects invalid tool arguments and unsafe shell blocks", () => {
    const risk = scoreHarnessLabRun({
      stdout: "The todowrite tool was called with invalid arguments: SchemaError(Expected array)",
      stderr: "blocked unsafe shell command: rm -rf is disallowed",
      exitCode: 2,
    });

    expect(risk.passed).toBe(false);
    expect(risk.signals.map((signal) => signal.kind)).toEqual(
      expect.arrayContaining(["invalid_tool_arguments", "unsafe_shell_block", "no_completion_signal"]),
    );
  });

  it("renders command placeholders without invoking a shell", () => {
    const spec: HarnessLabSpec = {
      name: "placeholder-test",
      client: {
        id: "opencode",
        command: "opencode",
        args: ["run", "--model", "{model}", "--session", "{sessionKey}", "--prompt-file", "{promptFile}"],
        env: {
          SYNESIS_WORKSPACE: "{workspace}",
        },
      },
      cases: [
        {
          id: "taskpulse",
          model: "core",
          sessionKey: "session-123",
          prompt: "Build TaskPulse",
        },
      ],
    };

    const rendered = renderCommand(spec, spec.cases[0]!, "/tmp/ws", "/tmp/ws/.synesis-harness-lab/prompt.txt");

    expect(rendered.command).toBe("opencode");
    expect(rendered.args).toEqual([
      "run",
      "--model",
      "core",
      "--session",
      "session-123",
      "--prompt-file",
      "/tmp/ws/.synesis-harness-lab/prompt.txt",
    ]);
    expect(rendered.cwd).toBe("/tmp/ws");
    expect(rendered.env.SYNESIS_WORKSPACE).toBe("/tmp/ws");
  });

  it("builds a fixture draft from captured transcript output", () => {
    const risk = scoreHarnessLabRun({
      stdout: "GOVERNOR PAUSE: Reason: verification_churn_no_edit",
      stderr: "",
      exitCode: 0,
      expected: {
        allowGovernorPause: false,
      },
    });
    const draft = buildHarnessLabFixtureDraft(
      {
        id: "minimax-verification-churn",
        prompt: "Build TaskPulse",
        tags: ["minimax", "taskpulse"],
        expected: {
          allowGovernorPause: false,
        },
      },
      {
        stdout: "GOVERNOR PAUSE: Reason: verification_churn_no_edit",
        stderr: "",
      },
      risk,
    );

    expect(draft.name).toBe("harness-lab-minimax-verification-churn");
    expect(draft.tags).toEqual(["harness_lab", "minimax", "taskpulse"]);
    expect(draft.expected.pauseAllowed).toBe(false);
    expect(draft.transcriptExcerpt).toContain("verification_churn_no_edit");
  });

  it("renders a compact markdown report", () => {
    const result: HarnessLabRunResult = {
      specName: "TaskPulse lower harness sweep",
      clientId: "opencode",
      startedAt: "2026-05-26T00:00:00.000Z",
      completedAt: "2026-05-26T00:00:01.000Z",
      durationMs: 1_000,
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        avgScore: 0.7,
        signalCounts: {
          path_confusion: 1,
        },
      },
      cases: [
        {
          caseId: "taskpulse",
          tags: ["minimax"],
          workspacePath: "/tmp/ws",
          command: {
            command: "opencode",
            args: ["run"],
            cwd: "/tmp/ws",
            env: {},
          },
          dryRun: false,
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          durationMs: 1_000,
          riskReport: {
            passed: false,
            score: 0.7,
            recommendedNextAction: "Preserve discovered workspace root and add path-stability replay coverage.",
            signals: [
              {
                kind: "path_confusion",
                severity: "error",
                detail: "Output suggests cwd/project-root path duplication or repeated missing-path reads.",
              },
            ],
          },
          fixtureDraft: {
            name: "harness-lab-taskpulse",
            description: "candidate",
            tags: ["harness_lab"],
            expected: {
              pauseAllowed: false,
              forbiddenSignals: [],
              requiredSignals: [],
            },
            transcriptExcerpt: "",
          },
        },
      ],
    };

    expect(renderHarnessLabMarkdown(result)).toContain("Harness Lab: TaskPulse lower harness sweep");
    expect(renderHarnessLabMarkdown(result)).toContain("path_confusion: 1");
  });
});
