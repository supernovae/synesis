import { describe, expect, it } from "vitest";
import { mapAnthropicToolNameToAcpKind } from "../src/acp/synesis-yarn-acp-agent.js";

describe("ACP tool kind mapping", () => {
  it("maps common coder tool names", () => {
    expect(mapAnthropicToolNameToAcpKind("Bash")).toBe("execute");
    expect(mapAnthropicToolNameToAcpKind("Read")).toBe("read");
    expect(mapAnthropicToolNameToAcpKind("Write")).toBe("edit");
    expect(mapAnthropicToolNameToAcpKind("custom_tool")).toBe("other");
  });
});
