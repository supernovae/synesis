import { describe, expect, it } from "vitest";

import { traceModelForPersistence } from "../src/state/session-persistence-runner.js";

describe("traceModelForPersistence", () => {
  it("uses the requested model unless it is empty or auto", () => {
    expect(traceModelForPersistence("resolved-model", "client-model")).toBe("client-model");
    expect(traceModelForPersistence("resolved-model", " auto ")).toBe("resolved-model");
    expect(traceModelForPersistence("resolved-model", " ")).toBe("resolved-model");
    expect(traceModelForPersistence("resolved-model")).toBe("resolved-model");
  });
});
