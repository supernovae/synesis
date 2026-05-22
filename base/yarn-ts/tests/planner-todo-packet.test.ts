import { describe, expect, it } from "vitest";
import { detectClientToolCapabilities } from "../src/adapters/client-tool-capabilities.js";
import {
  buildPlannerTodoPacketPrompt,
  formatPlannerTodoPacketBlock,
  parsePlannerTodoPacket,
  plannerTodoPacketToHarnessTasks,
  shouldGeneratePlannerTodoPacket,
  type PlannerTodoPacket,
} from "../src/planning/planner-todo-packet.js";

function opencodeCaps(prompt = "build a feature") {
  return detectClientToolCapabilities(
    [{ name: "todowrite" }, { name: "question" }, { name: "apply_patch" }],
    "opencode",
    prompt,
  );
}

function packet(overrides?: Partial<PlannerTodoPacket>): PlannerTodoPacket {
  return {
    schema_version: "synesis_planner_todo_packet_v1",
    objective: "Implement a durable planning flow",
    ambiguity: "low",
    questions: [],
    todos: [
      { id: "todo_1", content: "Inspect the existing request path", status: "pending" },
      { id: "todo_2", content: "Add focused verification", status: "pending" },
    ],
    success_criteria: ["Planner guidance is injected without forcing implementation"],
    ...overrides,
  };
}

describe("planner todo packet", () => {
  it("generates for macro prompts when planning was steered and a todo tool exists", () => {
    expect(shouldGeneratePlannerTodoPacket({
      enabled: true,
      promptScope: "macro",
      planningSteered: true,
      capabilities: opencodeCaps(),
    })).toBe(true);
  });

  it("generates for explicit /plan mode even when the prompt looks small", () => {
    expect(shouldGeneratePlannerTodoPacket({
      enabled: true,
      promptScope: "micro",
      planningSteered: true,
      planModeRequested: true,
      capabilities: opencodeCaps("/plan fix the import"),
    })).toBe(true);
  });

  it("does not generate when the user overrides planning or no native planning tool exists", () => {
    expect(shouldGeneratePlannerTodoPacket({
      enabled: true,
      promptScope: "macro",
      planningSteered: true,
      planningOverride: true,
      capabilities: opencodeCaps(),
    })).toBe(false);

    const genericCaps = detectClientToolCapabilities([{ name: "write" }], "generic", "build a feature");
    expect(shouldGeneratePlannerTodoPacket({
      enabled: true,
      promptScope: "macro",
      planningSteered: true,
      capabilities: genericCaps,
    })).toBe(false);
  });

  it("does not regenerate for a prompt that already has task state", () => {
    expect(shouldGeneratePlannerTodoPacket({
      enabled: true,
      promptScope: "macro",
      planningSteered: true,
      capabilities: opencodeCaps(),
      existingTaskCount: 2,
    })).toBe(false);
  });

  it("builds a bounded Horizon planning prompt with native tool names", () => {
    const prompt = buildPlannerTodoPacketPrompt({
      prompt: "/plan build a new API with auth and tests",
      sourceHash: "abc123",
      capabilities: opencodeCaps("/plan build a new API"),
      maxPromptChars: 80,
    });

    expect(prompt).toContain("Synesis Coder Horizon");
    expect(prompt).toContain("Return strict JSON only");
    expect(prompt).toContain("Native todo tool available: todowrite");
    expect(prompt).toContain("Native question tool available: question");
    expect(prompt).toContain("source_hash=abc123");
    expect(prompt).not.toContain("/plan build");
  });

  it("parses fenced JSON and normalizes todo ids", () => {
    const parsed = parsePlannerTodoPacket(`\`\`\`json
{
  "schema_version": "synesis_planner_todo_packet_v1",
  "objective": "Build a robust planner",
  "ambiguity": "none",
  "questions": [],
  "todos": [
    { "id": "todo 1", "content": "Inspect request flow", "status": "pending" },
    { "id": "todo 1", "content": "Add verification tests", "status": "pending" }
  ],
  "success_criteria": ["Tests cover packet parsing"]
}
\`\`\``);

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.packet?.todos[0]?.id).toBe("todo_1");
    expect(parsed.packet?.todos[1]?.id).toBe("todo_1_2");
  });

  it("formats a guidance block that prefers question then todowrite when ambiguity blocks progress", () => {
    const block = formatPlannerTodoPacketBlock({
      packet: packet({
        ambiguity: "high",
        questions: [
          {
            id: "q1",
            header: "Storage",
            question: "Which database should back the new API?",
            options: [
              { label: "Postgres", description: "Recommended for relational app data" },
              { label: "SQLite", description: "Simpler for local-only use" },
            ],
          },
        ],
      }),
      sourceHash: "abc123",
      modelId: "synesis-horizon",
      capabilities: opencodeCaps(),
    });

    expect(block).toContain("<synesis_planner_todo_packet");
    expect(block).toContain("question_tool=question");
    expect(block).toContain("todo_tool=todowrite");
    expect(block).toContain("next_action=ask_question_then_todowrite");
    expect(block).toContain("Which database should back the new API?");
  });

  it("maps planner todos into harness-inferred task ledger entries", () => {
    const tasks = plannerTodoPacketToHarnessTasks(packet(), 4);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.id).toBe("planner_todo_1");
    expect(tasks[0]!.source).toBe("harness_inferred");
    expect(tasks[0]!.lastUpdatedTurn).toBe(4);
    expect(tasks[0]!.evidence).toEqual(["planner_todo_packet"]);
  });
});
