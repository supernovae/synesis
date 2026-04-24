import { describe, expect, it } from "vitest";
import { resolveSupportHandle, withSupportHandleHint } from "../src/app.js";

describe("support handle fallback helpers", () => {
  it("prefers authz_trace_id over run_id", () => {
    const handle = resolveSupportHandle({
      authzTraceId: "trace-123",
      runId: "run-456",
    });
    expect(handle).toBe("trace-123");
  });

  it("falls back to run_id when trace id is missing", () => {
    const handle = resolveSupportHandle({
      authzTraceId: " ",
      runId: "run-456",
    });
    expect(handle).toBe("run-456");
  });

  it("appends support id once when available", () => {
    const first = withSupportHandleHint("Something went wrong.", {
      authzTraceId: "trace-abc",
    });
    expect(first).toBe("Something went wrong. (support id: trace-abc)");

    const second = withSupportHandleHint(first, {
      authzTraceId: "trace-abc",
    });
    expect(second).toBe(first);
  });
});
