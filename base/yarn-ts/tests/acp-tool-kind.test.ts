import { describe, expect, it } from "vitest";
import { mapCoderToolNameToAcpKind } from "../src/acp/synesis-yarn-acp-agent.js";

describe("ACP tool kind mapping", () => {
  it("maps common coder tool names (OpenAI / shared tool names)", () => {
    expect(mapCoderToolNameToAcpKind("Bash")).toBe("execute");
    expect(mapCoderToolNameToAcpKind("Read")).toBe("read");
    expect(mapCoderToolNameToAcpKind("Write")).toBe("edit");
    expect(mapCoderToolNameToAcpKind("custom_tool")).toBe("other");
  });
});
