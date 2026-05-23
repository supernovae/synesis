import { describe, expect, it } from "vitest";
import { inferKnowledgeGapMetadata } from "../src/knowledge-backlog.js";

describe("knowledge backlog metadata", () => {
  it("infers Go and backend context instead of defaulting to Python/generic", () => {
    const meta = inferKnowledgeGapMetadata({
      task_description:
        "For a Go HTTP service, how should I configure server timeouts, request context cancellation, and graceful shutdown?",
      taxonomy_metadata: {
        active_domains: ["golang", "web_backend"],
        taxonomy_key: "golang",
      },
      domain_profile: {
        domains: [
          { key: "golang", weight: 0.45 },
          { key: "backend_api", weight: 0.35 },
        ],
        frameCoherence: "composite",
      },
      task_frame: {
        domain_tags: ["golang", "web_backend"],
        technologies: ["go"],
      },
    });

    expect(meta.language).toBe("go");
    expect(meta.platform_context).toBe("backend_api");
  });

  it("leaves unknown language empty rather than inventing Python", () => {
    const meta = inferKnowledgeGapMetadata({
      task_description: "Compare several project management approaches for a remote design team.",
    });

    expect(meta.language).toBe("");
    expect(meta.platform_context).toBe("generic");
  });
});
