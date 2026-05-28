import { describe, expect, it } from "vitest";
import {
  buildDurableWorkPacketDecision,
  resolveWorkPacketMode,
} from "../src/memory/durable-work-packet.js";
import {
  deriveModelExecutionPolicy,
  resolveModelArchitectureProfile,
} from "../src/providers/model-architecture-profile.js";
import type { TaskLedger } from "../src/task-ledger/types.js";

function policyFor(modelId: string, family?: string) {
  return deriveModelExecutionPolicy(resolveModelArchitectureProfile({
    modelId,
    family,
    declaredContextTokens: 128_000,
  }));
}

const ledger: TaskLedger = {
  sessionId: "s1",
  hasExplicitClientTodoTool: true,
  hasExplicitPlanMode: false,
  reconciliationAttempts: 0,
  tasks: [
    {
      id: "1",
      title: "Create FastAPI task API",
      status: "completed",
      source: "opencode_todowrite",
      evidence: ["taskpulse/app/api/tasks.py"],
      createdTurn: 1,
      lastUpdatedTurn: 4,
      confidence: 0.9,
    },
    {
      id: "2",
      title: "Run pytest validation",
      status: "in_progress",
      source: "opencode_todowrite",
      evidence: [],
      createdTurn: 1,
      lastUpdatedTurn: 5,
      confidence: 0.9,
    },
  ],
};

describe("durable work packet", () => {
  it("resolves request-controlled memory modes", () => {
    expect(resolveWorkPacketMode({ metadata: { synesis_memory: "observe" } })).toBe("observe");
    expect(resolveWorkPacketMode({ extraBody: { synesis_work_packet: "off" } })).toBe("off");
    expect(resolveWorkPacketMode({ configMode: "strict" })).toBe("aggressive");
    expect(resolveWorkPacketMode({ metadata: { synesis_memory: "off" }, configMode: "strict" })).toBe("off");
    expect(resolveWorkPacketMode({ metadata: { synesis_memory_mediation: "always" } })).toBe("aggressive");
    expect(resolveWorkPacketMode({ metadata: { synesis: { contextMediation: "safe" } } })).toBe("safe");
    expect(resolveWorkPacketMode({})).toBe("adaptive");
  });

  it("injects tail-state for DeepSeek-style architecture policy", () => {
    const decision = buildDurableWorkPacketDecision({
      sessionKey: "s1",
      messages: [
        { role: "user", content: "Build TaskPulse and validate tests" },
        { role: "tool", content: "pytest failed in taskpulse/tests/test_tasks.py with ModuleNotFoundError" },
      ],
      taskLedger: ledger,
      projectRoot: "/home/byron/src/test",
      shellCwd: "/home/byron/src/test",
      modelPolicy: policyFor("deepseek-v4-flash", "deepseek"),
    });

    expect(decision.inject).toBe(true);
    expect(decision.packet?.block).toContain("<SYNESIS_CURRENT_WORK_PACKET");
    expect(decision.packet?.block).toContain("<SYNESIS_ACTIVE_STATE");
    expect(decision.packet?.block).toContain("latest_tool_truth");
    expect(decision.packet?.block).toContain("Run pytest validation");
    expect(decision.reasons).toContain("prefer_recent_tool_state_replay");
    expect(decision.packet?.criticalFactPinCount).toBeGreaterThan(0);
  });

  it("observes but does not inject when requested", () => {
    const decision = buildDurableWorkPacketDecision({
      sessionKey: "s1",
      messages: [{ role: "user", content: "Continue implementation" }],
      taskLedger: ledger,
      modelPolicy: policyFor("mimo-v2-flash", "xiaomi"),
      metadata: { synesis_memory: "observe" },
    });

    expect(decision.mode).toBe("observe");
    expect(decision.inject).toBe(false);
    expect(decision.packet?.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(decision.contextArtifacts.evidenceManifest.length).toBeGreaterThan(0);
  });

  it("keeps path and tracker failures as do-not-repeat guidance", () => {
    const decision = buildDurableWorkPacketDecision({
      sessionKey: "s1",
      messages: [
        { role: "user", content: "Please continue" },
        {
          role: "tool",
          content: "SchemaError invalid arguments for todowrite. File not found: /home/byron/src/test/src/test/taskpulse/app/main.py",
        },
      ],
      taskLedger: ledger,
      projectRoot: "/home/byron/src/test",
      shellCwd: "/home/byron/src/test",
      modelPolicy: policyFor("mimo-v2-flash", "xiaomi"),
    });

    expect(decision.packet?.block).toContain("Task/todo tracker schema failed");
    expect(decision.packet?.block).toContain("Do not rebuild completed files");
    expect(decision.packet?.block).toContain("duplicated path prefix");
    expect(decision.packet?.block).toContain("canonical workspace root is /home/byron/src/test");
    expect(decision.packet?.block).toContain("use taskpulse/app/main.py relative to that root");
  });
});
