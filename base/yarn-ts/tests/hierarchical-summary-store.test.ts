import { describe, expect, it } from "vitest";
import { createHierarchicalSummaryStore } from "../src/memory/summary-store.js";

describe("createHierarchicalSummaryStore", () => {
  it("applies a sanitized session scope to the store", () => {
    const sk = "synesis:user1:claude:conv-a";
    const expectedScope = sk.replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 200);
    const a = createHierarchicalSummaryStore(null, 100, 3600, sk);
    expect((a as unknown as { keyScope: string }).keyScope).toBe(expectedScope);
  });
});
