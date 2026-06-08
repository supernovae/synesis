import { describe, expect, it } from "vitest";
import { EvidencePacketSchema, EvidenceSourceSchema } from "../src/contracts/schemas.js";

describe("planner contract schema hardening", () => {
  it("rejects invented evidence source metadata fields", () => {
    expect(() => EvidenceSourceSchema.parse({
      uri: "https://docs.example.com",
      type: "doc",
      metadata: {
        document_name: "Reference",
        role_override: "platform_admin",
      },
    })).toThrow(/role_override/);
  });

  it("accepts only known evidence provenance metadata fields", () => {
    const parsed = EvidencePacketSchema.parse({
      query: "planner security",
      sources: [{
        uri: "https://docs.example.com",
        type: "doc",
        metadata: {
          authority: "canonical",
          document_name: "Reference",
          scan_status: "clean",
          review_status: "vetted",
        },
      }],
      snippets: [],
    });

    expect(parsed.sources[0]?.metadata).toEqual({
      authority: "canonical",
      document_name: "Reference",
      scan_status: "clean",
      review_status: "vetted",
    });
  });
});
