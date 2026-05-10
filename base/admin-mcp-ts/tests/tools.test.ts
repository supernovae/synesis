import { describe, expect, it } from "vitest";
import { isOrgAdminOrHigher, visibleToolDescriptorsForRole } from "../src/tools.js";

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
});
