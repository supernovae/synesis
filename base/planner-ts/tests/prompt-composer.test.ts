import { describe, expect, it } from "vitest";
import { composePlannerPrompt } from "../src/prompt-composer.js";

describe("planner prompt composer", () => {
  it("falls back to base when no snapshot loaded", () => {
    const out = composePlannerPrompt("base-planner", { role: "router", node: "planner" });
    expect(out.content).toBe("base-planner");
    expect(out.profileIds).toEqual([]);
  });

  it("applies default -> tier -> model_family -> chat_profile -> role -> node overlays", () => {
    const snapshot = {
      service: "planner",
      profiles: [
        { id: 10, name: "default", service: "planner", content: "default-overlay", content_hash: "h10" },
        { id: 11, name: "tier", service: "planner", content: "tier-overlay", content_hash: "h11" },
        { id: 12, name: "family", service: "planner", content: "family-overlay", content_hash: "h12" },
        { id: 13, name: "role", service: "planner", content: "role-overlay", content_hash: "h13" },
        { id: 14, name: "node", service: "planner", content: "node-overlay", content_hash: "h14" },
        { id: 15, name: "chat profile", service: "planner", content: "chat-profile-overlay", content_hash: "h15" },
      ],
      assignments: [
        { id: 1, service: "planner", target_type: "default", target_value: "*", profile_id: 10 },
        { id: 2, service: "planner", target_type: "tier", target_value: "core", profile_id: 11 },
        { id: 3, service: "planner", target_type: "model_family", target_value: "qwen3-coder", profile_id: 12 },
        { id: 4, service: "planner", target_type: "role", target_value: "critic", profile_id: 13 },
        { id: 5, service: "planner", target_type: "node", target_value: "critic", profile_id: 14 },
        { id: 6, service: "planner", target_type: "chat_profile", target_value: "roleplay_creative_continuity", profile_id: 15 },
      ],
      updated_at: null,
    };

    const out = composePlannerPrompt("base", {
      tier: "core",
      chatProfile: "roleplay_creative_continuity",
      role: "critic",
      node: "critic",
      model: "Qwen/Qwen3-Coder-32B-Instruct",
    }, snapshot);

    expect(out.content).toContain("base");
    expect(out.content).toContain("default-overlay");
    expect(out.content).toContain("tier-overlay");
    expect(out.content).toContain("family-overlay");
    expect(out.content).toContain("chat-profile-overlay");
    expect(out.content).toContain("role-overlay");
    expect(out.content).toContain("node-overlay");
    expect(out.profileIds).toEqual([10, 11, 12, 15, 13, 14]);
    expect(out.profileHashes).toEqual(["h10", "h11", "h12", "h15", "h13", "h14"]);
  });

  it("applies Xiaomi model_family overlay for MiMo models", () => {
    const snapshot = {
      service: "planner",
      profiles: [
        { id: 20, name: "xiaomi", service: "planner", content: "xiaomi-overlay", content_hash: "h20" },
      ],
      assignments: [
        { id: 10, service: "planner", target_type: "model_family", target_value: "xiaomi", profile_id: 20 },
      ],
      updated_at: null,
    };

    const out = composePlannerPrompt("base", { model: "mimo-v2.5-pro" }, snapshot);

    expect(out.content).toContain("xiaomi-overlay");
    expect(out.profileIds).toEqual([20]);
  });
});
