import { describe, expect, it } from "vitest";
import {
  parsePlanTodos,
  buildShadowFromContent,
  checkMonotonicity,
  containsStubPhrase,
  hasValidPlanStructure,
  validatePlanWriteContent,
  hashContent,
  serializeShadow,
  deserializeShadow,
  type PlanContentShadow,
} from "../src/planning/plan-content-shadow.js";

const SAMPLE_PLAN = [
  "---",
  "name: Test Plan",
  "todos:",
  "  - id: task1",
  "    content: Build feature",
  "    status: completed",
  "  - id: task2",
  "    content: Write tests",
  "    status: in_progress",
  "  - id: task3",
  "    content: Deploy",
  "    status: pending",
  "isProject: false",
  "---",
  "",
  "# Test Plan",
  "Some body content here.",
].join("\n");

describe("parsePlanTodos", () => {
  it("extracts todos from YAML frontmatter", () => {
    const todos = parsePlanTodos(SAMPLE_PLAN);
    expect(todos).toHaveLength(3);
    expect(todos[0]).toEqual({ id: "task1", content: "Build feature", status: "completed" });
    expect(todos[1]).toEqual({ id: "task2", content: "Write tests", status: "in_progress" });
    expect(todos[2]).toEqual({ id: "task3", content: "Deploy", status: "pending" });
  });

  it("returns empty for content without frontmatter", () => {
    expect(parsePlanTodos("# No frontmatter")).toEqual([]);
  });

  it("returns empty for frontmatter without todos", () => {
    expect(parsePlanTodos("---\nname: Plan\n---\n# Body")).toEqual([]);
  });

  it("handles quoted status values", () => {
    const content = '---\ntodos:\n  - id: t1\n    content: Test\n    status: "completed"\n---\n';
    const todos = parsePlanTodos(content);
    expect(todos).toHaveLength(1);
    expect(todos[0].status).toBe("completed");
  });

  it("defaults invalid status to pending", () => {
    const content = "---\ntodos:\n  - id: t1\n    content: Test\n    status: invalid_status\n---\n";
    const todos = parsePlanTodos(content);
    expect(todos).toHaveLength(1);
    expect(todos[0].status).toBe("pending");
  });
});

describe("buildShadowFromContent", () => {
  it("builds a shadow with hash, length, and parsed todos", () => {
    const shadow = buildShadowFromContent("/test/plan.md", SAMPLE_PLAN);
    expect(shadow.path).toBe("/test/plan.md");
    expect(shadow.contentLength).toBe(SAMPLE_PLAN.length);
    expect(shadow.contentHash).toBeTruthy();
    expect(shadow.todos).toHaveLength(3);
    expect(shadow.lastReadAt).toBeGreaterThan(0);
  });
});

describe("checkMonotonicity", () => {
  const shadow: PlanContentShadow = {
    path: "/test/plan.md",
    contentHash: "abc",
    contentLength: 500,
    todos: [
      { id: "task1", content: "A", status: "completed" },
      { id: "task2", content: "B", status: "in_progress" },
      { id: "task3", content: "C", status: "pending" },
    ],
    lastReadAt: Date.now(),
  };

  it("allows forward transitions", () => {
    const violations = checkMonotonicity(shadow, [
      { id: "task1", content: "A", status: "completed" },
      { id: "task2", content: "B", status: "completed" },
      { id: "task3", content: "C", status: "in_progress" },
    ]);
    expect(violations).toHaveLength(0);
  });

  it("detects completed->pending regression", () => {
    const violations = checkMonotonicity(shadow, [
      { id: "task1", content: "A", status: "pending" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].todoId).toBe("task1");
    expect(violations[0].previousStatus).toBe("completed");
    expect(violations[0].proposedStatus).toBe("pending");
  });

  it("detects in_progress->pending regression", () => {
    const violations = checkMonotonicity(shadow, [
      { id: "task2", content: "B", status: "pending" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].todoId).toBe("task2");
  });

  it("allows new todos not in shadow", () => {
    const violations = checkMonotonicity(shadow, [
      { id: "new_task", content: "New", status: "pending" },
    ]);
    expect(violations).toHaveLength(0);
  });

  it("allows cancelled from any non-terminal state", () => {
    const violations = checkMonotonicity(shadow, [
      { id: "task2", content: "B", status: "cancelled" },
      { id: "task3", content: "C", status: "cancelled" },
    ]);
    expect(violations).toHaveLength(0);
  });

  it("blocks cancelled->pending regression", () => {
    const shadowWithCancelled: PlanContentShadow = {
      ...shadow,
      todos: [{ id: "t1", content: "X", status: "cancelled" }],
    };
    const violations = checkMonotonicity(shadowWithCancelled, [
      { id: "t1", content: "X", status: "pending" },
    ]);
    expect(violations).toHaveLength(1);
  });
});

describe("containsStubPhrase", () => {
  it("detects 'unchanged since last read'", () => {
    expect(containsStubPhrase("Unchanged since last read")).toBeTruthy();
  });

  it("detects '<FILE_UNCHANGED'", () => {
    expect(containsStubPhrase('<FILE_UNCHANGED path="main.go" />')).toBeTruthy();
  });

  it("detects 'read_cache_stub'", () => {
    expect(containsStubPhrase("guardrail: read_cache_stub")).toBeTruthy();
  });

  it("returns null for normal content", () => {
    expect(containsStubPhrase("# Plan\n- task A\n- task B")).toBeNull();
  });
});

describe("hasValidPlanStructure", () => {
  it("returns true for content with YAML delimiter", () => {
    expect(hasValidPlanStructure("---\nname: test\n---\nbody")).toBe(true);
  });

  it("returns false for short content", () => {
    expect(hasValidPlanStructure("short")).toBe(false);
  });

  it("returns false for content without ---", () => {
    expect(hasValidPlanStructure("# Plan\nSome content here without delimiters")).toBe(false);
  });
});

describe("validatePlanWriteContent", () => {
  it("blocks content too short for full write", () => {
    const r = validatePlanWriteContent("tiny", null, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("content_too_short");
  });

  it("blocks stub phrases", () => {
    const r = validatePlanWriteContent("Unchanged since last read and more text", null, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("contains_stub_phrase");
  });

  it("blocks missing YAML frontmatter for full writes", () => {
    const r = validatePlanWriteContent("# Plan without frontmatter that is long enough to pass length check", null, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("missing_yaml_frontmatter");
  });

  it("allows partial edits without frontmatter", () => {
    const r = validatePlanWriteContent("    status: completed", null, true);
    expect(r.allowed).toBe(true);
  });

  it("blocks size regression against shadow", () => {
    const shadow: PlanContentShadow = {
      path: "/test.md",
      contentHash: "abc",
      contentLength: 1000,
      todos: [],
      lastReadAt: Date.now(),
    };
    const r = validatePlanWriteContent("---\nname: tiny\n---\nshort", shadow, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("size_regression");
  });

  it("allows valid full write", () => {
    const r = validatePlanWriteContent(SAMPLE_PLAN, null, false);
    expect(r.allowed).toBe(true);
  });

  it("detects monotonicity violations against shadow", () => {
    const shadow: PlanContentShadow = {
      path: "/test.md",
      contentHash: "abc",
      contentLength: SAMPLE_PLAN.length,
      todos: [
        { id: "task1", content: "Build feature", status: "completed" },
      ],
      lastReadAt: Date.now(),
    };
    const regressed = SAMPLE_PLAN.replace("status: completed", "status: pending");
    const r = validatePlanWriteContent(regressed, shadow, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("monotonicity_violation");
    expect(r.violations).toHaveLength(1);
  });
});

describe("serialize/deserialize round-trip", () => {
  it("preserves shadow data", () => {
    const shadow = buildShadowFromContent("/test/plan.md", SAMPLE_PLAN);
    const serialized = serializeShadow(shadow);
    const restored = deserializeShadow(serialized);
    expect(restored).toBeTruthy();
    expect(restored!.path).toBe(shadow.path);
    expect(restored!.contentHash).toBe(shadow.contentHash);
    expect(restored!.contentLength).toBe(shadow.contentLength);
    expect(restored!.todos).toEqual(shadow.todos);
  });

  it("returns null for invalid data", () => {
    expect(deserializeShadow(null)).toBeNull();
    expect(deserializeShadow({})).toBeNull();
    expect(deserializeShadow("string")).toBeNull();
  });
});

describe("hashContent", () => {
  it("returns consistent hash for same input", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("returns different hash for different input", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});
