import { describe, expect, it } from "vitest";

import { buildRouteDependencyGroups } from "../src/server/route-dependency-groups.js";

describe("buildRouteDependencyGroups", () => {
  it("preserves platform telemetry dependencies that are only used by health telemetry", () => {
    const attentionPositioning = { getStats: () => ({ enabled: true }) };
    const toolPrefixCache = { getStats: () => ({ enabled: true }) };

    const groups = buildRouteDependencyGroups({
      attentionPositioning,
      toolPrefixCache,
    });

    expect(groups.telemetry.attentionPositioning).toBe(attentionPositioning);
    expect(groups.telemetry.yarnToolPrefixCache).toBe(toolPrefixCache);
  });
});
