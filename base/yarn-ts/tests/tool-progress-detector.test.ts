import { describe, expect, it } from "vitest";
import {
  detectToolProgress,
  type ToolProgressMessage,
  type ToolProgressSessionState,
} from "../src/policy/tool-progress-detector.js";

function sessionState(): ToolProgressSessionState {
  return {
    lastToolSignalHash: "",
    stagnantToolCycles: 0,
  };
}

describe("tool-progress-detector", () => {
  it("returns unknown when no tool results exist", () => {
    const session = sessionState();
    const out = detectToolProgress(session, [
      { role: "assistant", content: "thinking..." },
    ]);
    expect(out.state).toBe("unknown");
    expect(out.signalHash).toBeNull();
    expect(session.stagnantToolCycles).toBe(0);
  });

  it("marks first tool output as progress", () => {
    const session = sessionState();
    const messages: ToolProgressMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "Read" } }] },
      { role: "tool", name: "Read", tool_call_id: "t1", content: "package main" },
    ];
    const out = detectToolProgress(session, messages);
    expect(out.state).toBe("progress");
    expect(out.signalHash).toBeTruthy();
    expect(session.stagnantToolCycles).toBe(0);
  });

  it("marks repeated non-write output as stagnant", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "Read" } }] },
      { role: "tool", name: "Read", tool_call_id: "t1", content: "same output" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      { role: "assistant", content: "", tool_calls: [{ id: "t2", function: { name: "Read" } }] },
      { role: "tool", name: "Read", tool_call_id: "t2", content: "same output" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("stagnant");
    expect(session.stagnantToolCycles).toBe(1);
  });

  it("treats repeated successful write output as progress", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "w1", function: { name: "Write" } }] },
      { role: "tool_result", tool_call_id: "w1", content: "Updated cmd/synesis/ask.go successfully" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      { role: "assistant", content: "", tool_calls: [{ id: "w2", function: { name: "Write" } }] },
      { role: "tool_result", tool_call_id: "w2", content: "Updated cmd/synesis/ask.go successfully" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("progress");
    expect(session.stagnantToolCycles).toBe(0);
  });

  it("treats Bash heredoc file writes as progress even with repeated empty output", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b1", function: { name: "Bash", arguments: "{\"command\":\"cat > requirements.txt << 'EOF'\\nfastapi\\nEOF\"}" } }],
      },
      { role: "tool", name: "Bash", tool_call_id: "b1", content: "(no output)" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b2", function: { name: "Bash", arguments: "{\"command\":\"cat > taskpulse/__init__.py << 'EOF'\\n\\\"\\\"\\\"TaskPulse.\\\"\\\"\\\"\\nEOF\"}" } }],
      },
      { role: "tool", name: "Bash", tool_call_id: "b2", content: "(no output)" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("progress");
    expect(session.stagnantToolCycles).toBe(0);
  });

  it("does not force progress for write alias when output indicates failure", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "w1", function: { name: "apply_patch" } }] },
      { role: "tool", name: "apply_patch", tool_call_id: "w1", content: "Error editing file: old_string not found" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      { role: "assistant", content: "", tool_calls: [{ id: "w2", function: { name: "apply_patch" } }] },
      { role: "tool", name: "apply_patch", tool_call_id: "w2", content: "Error editing file: old_string not found" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("stagnant");
    expect(session.stagnantToolCycles).toBe(1);
  });

  it("treats changing failure text on the same tool as stagnant", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "w1", function: { name: "apply_patch" } }] },
      { role: "tool", name: "apply_patch", tool_call_id: "w1", content: "Error editing file: old_string not found" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      { role: "assistant", content: "", tool_calls: [{ id: "w2", function: { name: "apply_patch" } }] },
      { role: "tool", name: "apply_patch", tool_call_id: "w2", content: "Failed to apply patch: did not match file content" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("stagnant");
    expect(session.stagnantToolCycles).toBe(1);
  });

  it("treats repeated non-write failures for the same command as stagnant", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b1", function: { name: "Bash", arguments: "{\"command\":\"go test ./pkg/jq/ -run TestApply_FieldAccess\"}" } }],
      },
      { role: "tool", name: "Bash", tool_call_id: "b1", content: "Error: Exit code 1\n--- FAIL: TestApply_FieldAccess (0.00s)" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b2", function: { name: "Bash", arguments: "{\"command\":\"go test ./pkg/jq/ -run TestApply_FieldAccess\"}" } }],
      },
      { role: "tool", name: "Bash", tool_call_id: "b2", content: "Error: Exit code 1\n--- FAIL: TestApply_FieldAccess (0.00s)" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("stagnant");
    expect(session.stagnantToolCycles).toBe(1);
  });

  it("treats non-write failures for different commands as progress", () => {
    const session = sessionState();
    const first: ToolProgressMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b1", function: { name: "Bash", arguments: "{\"command\":\"go test ./pkg/jq/ -run TestApply_FieldAccess\"}" } }],
      },
      { role: "tool", name: "Bash", tool_call_id: "b1", content: "Error: Exit code 1\n--- FAIL: TestApply_FieldAccess (0.00s)" },
    ];
    const second: ToolProgressMessage[] = [
      ...first,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "b2", function: { name: "Bash", arguments: "{\"command\":\"go test ./pkg/jq/ -run TestApply_ArrayIndex\"}" } }],
      },
      { role: "tool", name: "Bash", tool_call_id: "b2", content: "Error: Exit code 1\n--- FAIL: TestApply_ArrayIndex (0.00s)" },
    ];
    detectToolProgress(session, first);
    const out = detectToolProgress(session, second);
    expect(out.state).toBe("progress");
    expect(session.stagnantToolCycles).toBe(0);
  });
});
