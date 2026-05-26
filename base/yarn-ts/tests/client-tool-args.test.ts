import { describe, expect, it } from "vitest";
import { restoreToolArgsToClientSchema } from "../src/adapters/client-tool-args.js";

describe("client tool argument restoration", () => {
  it("restores internal Glob args to OpenCode's pattern schema", () => {
    const out = restoreToolArgsToClientSchema(
      "Glob",
      { glob_pattern: "**/*.py" },
      [{
        type: "function",
        function: {
          name: "Glob",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string" },
            },
            required: ["pattern"],
          },
        },
      }],
      "opencode",
    );

    expect(out).toEqual({ pattern: "**/*.py" });
  });

  it("keeps internal Glob args when the offered schema requires glob_pattern", () => {
    const out = restoreToolArgsToClientSchema(
      "Glob",
      { glob_pattern: "**/*.ts" },
      [{
        type: "function",
        function: {
          name: "Glob",
          parameters: {
            type: "object",
            properties: {
              glob_pattern: { type: "string" },
            },
            required: ["glob_pattern"],
          },
        },
      }],
      "claude-code",
    );

    expect(out).toEqual({ glob_pattern: "**/*.ts" });
  });

  it("repairs TodoWrite title items to OpenCode content items", () => {
    const out = restoreToolArgsToClientSchema(
      "todowrite",
      {
        todos: [
          { title: "Inspect the repo", status: "pending" },
          "Add focused tests",
        ],
      },
      [{
        type: "function",
        function: {
          name: "todowrite",
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string" },
                    priority: { type: "string" },
                  },
                  required: ["id", "content", "status", "priority"],
                },
              },
            },
            required: ["todos"],
          },
        },
      }],
      "opencode",
    );

    expect(out).toEqual({
      todos: [
        { id: "todo_1", content: "Inspect the repo", status: "pending", priority: "medium" },
        { id: "todo_2", content: "Add focused tests", status: "pending", priority: "medium" },
      ],
    });
  });

  it("repairs stringified TodoWrite todos arrays before returning calls to OpenCode", () => {
    const out = restoreToolArgsToClientSchema(
      "todowrite",
      {
        todos: JSON.stringify([
          { content: "Create project structure", id: "todo_1", status: "pending", priority: "high" },
          { content: "Implement API routes", id: "todo_2", status: "pending", priority: "high" },
        ]),
      },
      [{
        type: "function",
        function: {
          name: "todowrite",
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string" },
                    priority: { type: "string" },
                  },
                  required: ["id", "content", "status", "priority"],
                },
              },
            },
            required: ["todos"],
          },
        },
      }],
      "opencode",
    );

    expect(out).toEqual({
      todos: [
        { content: "Create project structure", id: "todo_1", status: "pending", priority: "high" },
        { content: "Implement API routes", id: "todo_2", status: "pending", priority: "high" },
      ],
    });
  });

  it("restores file arg casing when the offered schema uses camelCase", () => {
    const out = restoreToolArgsToClientSchema(
      "str_replace",
      { file_path: "src/app.ts", old_string: "old", new_string: "new" },
      [{
        type: "function",
        function: {
          name: "str_replace",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["filePath", "oldString", "newString"],
          },
        },
      }],
      "opencode",
    );

    expect(out).toEqual({ filePath: "src/app.ts", oldString: "old", newString: "new" });
  });
});
