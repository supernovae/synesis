import { describe, expect, it } from "vitest";
import { AdminMcpToolError, invokeTool, isOrgAdminOrHigher, visibleToolDescriptorsForRole } from "../src/tools.js";

describe("admin MCP tool catalog", () => {
  it("requires org_admin+ for visibility", () => {
    expect(visibleToolDescriptorsForRole("user")).toHaveLength(0);
    expect(visibleToolDescriptorsForRole("readonly")).toHaveLength(0);
    expect(visibleToolDescriptorsForRole("org_admin").length).toBeGreaterThan(10);
  });

  it("includes transition-quality tools for org_admin", () => {
    const names = new Set(visibleToolDescriptorsForRole("org_admin").map((t) => t.name));
    expect(names.has("yarn_transition_quality")).toBe(true);
    expect(names.has("yarn_transition_events_tail")).toBe(true);
    expect(names.has("yarn_transition_watch")).toBe(true);
    expect(names.has("yarn_transition_incident_brief")).toBe(true);
  });

  it("keeps platform-admin tools restricted", () => {
    const orgNames = new Set(visibleToolDescriptorsForRole("org_admin").map((t) => t.name));
    const platformNames = new Set(visibleToolDescriptorsForRole("platform_admin").map((t) => t.name));
    expect(orgNames.has("refresh_model_routes")).toBe(false);
    expect(platformNames.has("refresh_model_routes")).toBe(true);
  });

  it("treats admin aliases as admin", () => {
    expect(isOrgAdminOrHigher("admin")).toBe(true);
    expect(isOrgAdminOrHigher("platform_admin")).toBe(true);
    expect(isOrgAdminOrHigher("user")).toBe(false);
  });

  it("rejects extra tool arguments before forwarding to Admin API", async () => {
    await expect(
      invokeTool(
        {
          cfg: {
            SYNESIS_ADMIN_API_URL: "http://admin.local",
            SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
          } as never,
          delegatedHeaders: { Cookie: "synesis_admin_session=session" },
          orgHeaders: {},
          userId: "u1",
          role: "platform_admin",
        },
        "platform_admin",
        "ingestion_patch_item",
        { item_id: 1, unexpected: true },
      ),
    ).rejects.toBeInstanceOf(AdminMcpToolError);
  });

  it("rejects overly long transition watches", async () => {
    await expect(
      invokeTool(
        {
          cfg: {
            SYNESIS_ADMIN_API_URL: "http://admin.local",
            SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 1000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
          } as never,
          delegatedHeaders: { Cookie: "synesis_admin_session=session" },
          orgHeaders: {},
          userId: "u1",
          role: "org_admin",
        },
        "org_admin",
        "yarn_transition_watch",
        { polls: 2, interval_seconds: 2 },
      ),
    ).rejects.toMatchObject({ code: "watch_duration_exceeded" });
  });
});
