import { describe, expect, it } from "vitest";
import {
  detectContentType,
  compressLogStream,
  summarizeJsonObject,
  ContentDispatchService
} from "../src/reduction/content-dispatch.js";

describe("detectContentType", () => {
  it("detects json-array", () => {
    const arr = JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }]);
    expect(detectContentType(arr)).toBe("json-array");
  });

  it("detects json-object", () => {
    expect(detectContentType('{"key": "value", "count": 5}')).toBe("json-object");
  });

  it("detects log-stream", () => {
    const logs = [
      "2024-01-15T10:30:00Z INFO Starting server",
      "2024-01-15T10:30:01Z DEBUG Connecting to database",
      "2024-01-15T10:30:02Z INFO Server ready on port 8080",
      "2024-01-15T10:30:03Z WARN Slow query detected",
      "2024-01-15T10:30:04Z ERROR Connection timeout",
      "2024-01-15T10:30:05Z INFO Retrying connection"
    ].join("\n");
    expect(detectContentType(logs)).toBe("log-stream");
  });

  it("detects text for plain content", () => {
    expect(detectContentType("just some regular text\nwith multiple lines")).toBe("text");
  });

  it("returns text for invalid JSON starting with [", () => {
    expect(detectContentType("[not valid json")).toBe("text");
  });

  it("returns text for small JSON arrays", () => {
    expect(detectContentType('[{"a":1}]')).toBe("text");
  });
});

describe("compressLogStream", () => {
  function makeLogs(n: number): string {
    return Array.from({ length: n }, (_, i) => {
      const level = i === 50 ? "ERROR" : i === 51 ? "WARN" : "INFO";
      return `2024-01-15T10:${String(i).padStart(2, "0")}:00Z ${level} Log line ${i}`;
    }).join("\n");
  }

  it("returns raw for short logs", () => {
    const short = "line1\nline2\nline3";
    expect(compressLogStream(short)).toBe(short);
  });

  it("compresses long log output", () => {
    const logs = makeLogs(200);
    const compressed = compressLogStream(logs);
    expect(compressed).toContain("<LOG_STREAM");
    expect(compressed).toContain("</LOG_STREAM>");
    expect(compressed).toContain("lines omitted");
    expect(compressed.length).toBeLessThan(logs.length);
  });

  it("preserves error lines", () => {
    const logs = makeLogs(100);
    const compressed = compressLogStream(logs);
    expect(compressed).toContain("ERROR");
  });

  it("preserves warning lines", () => {
    const logs = makeLogs(100);
    const compressed = compressLogStream(logs);
    expect(compressed).toContain("WARN");
  });
});

describe("summarizeJsonObject", () => {
  it("returns raw for small objects", () => {
    const small = '{"key": "value"}';
    expect(summarizeJsonObject(small)).toBe(small);
  });

  it("summarizes large objects", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      obj[`key_${i}`] = "x".repeat(300);
    }
    const raw = JSON.stringify(obj);
    const summary = summarizeJsonObject(raw);
    expect(summary).toContain("<JSON_SUMMARY");
    expect(summary).toContain("</JSON_SUMMARY>");
    expect(summary.length).toBeLessThan(raw.length);
  });

  it("truncates long string values", () => {
    const obj = { data: "x".repeat(500) };
    const summary = summarizeJsonObject(JSON.stringify(obj), 100);
    expect(summary).toContain("...");
  });

  it("summarizes large arrays as count", () => {
    const obj = { items: Array.from({ length: 100 }, (_, i) => i) };
    const summary = summarizeJsonObject(JSON.stringify(obj), 100);
    expect(summary).toContain("Array(100)");
  });
});

describe("ContentDispatchService", () => {
  it("dispatches log streams with compression", () => {
    const svc = new ContentDispatchService();
    const logs = Array.from({ length: 100 }, (_, i) =>
      `2024-01-15T10:00:${String(i).padStart(2, "0")}Z INFO Line ${i}`
    ).join("\n");
    const result = svc.dispatch(logs);
    expect(result.type).toBe("log-stream");
    expect(result.transformed).not.toBeNull();
    expect(result.transformed!).toContain("<LOG_STREAM");
  });

  it("returns null transform for text (pass to classifier)", () => {
    const svc = new ContentDispatchService();
    const result = svc.dispatch("regular tool output text");
    expect(result.type).toBe("text");
    expect(result.transformed).toBeNull();
  });

  it("returns null transform for json-array (handled by json compactor)", () => {
    const svc = new ContentDispatchService();
    const arr = JSON.stringify([{ id: 1, s: "a" }, { id: 2, s: "b" }, { id: 3, s: "c" }]);
    const result = svc.dispatch(arr);
    expect(result.type).toBe("json-array");
    expect(result.transformed).toBeNull();
  });

  it("tracks stats", () => {
    const svc = new ContentDispatchService();
    svc.dispatch("text content");
    svc.dispatch('{"key":"val"}');
    const stats = svc.getStats();
    expect(stats.dispatched).toBe(2);
    expect(stats.byType.text).toBe(1);
    expect(stats.byType["json-object"]).toBe(1);
  });
});
