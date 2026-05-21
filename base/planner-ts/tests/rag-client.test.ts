import { afterEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const closeMock = vi.fn();
const sessionMock = vi.fn(() => ({ run: runMock, close: closeMock }));
const driverMock = vi.fn(() => ({ session: sessionMock, close: vi.fn() }));

vi.mock("neo4j-driver", () => ({
  default: {
    driver: driverMock,
    auth: { basic: vi.fn((user: string, password: string) => ({ user, password })) },
    isInt: vi.fn(() => false),
  },
}));

const { retrieveContext, retrieveKnowledgeBundle } = await import("../src/retrieval/rag-client.js");
const { setFgaCheckOverride } = await import("../src/auth/openfga-client.js");
import type { RagClientConfig } from "../src/retrieval/rag-client.js";

const baseConfig: RagClientConfig = {
  nornicUri: "bolt://nornic.local:7687",
  nornicUser: "neo4j",
  nornicPassword: "secret",
  nornicDatabase: "nornic",
  nornicVectorIndex: "embeddings",
  nornicRuntimeProfile: "cpu-bge",
  embedderUrl: "",
  embedderModel: "BAAI/bge-m3",
  retrievalStrategy: "hybrid",
  rrfK: 60,
  scoreThreshold: 0,
  rerankScoreMin: 0,
  graphDepth: 2,
  edgeTypes: ["DEFINES", "CALLS", "IMPORTS"],
  rerankEnabled: true,
  timeoutMs: 1000,
};

afterEach(() => {
  runMock.mockReset();
  closeMock.mockReset();
  sessionMock.mockClear();
  setFgaCheckOverride(null);
});

describe("retrieveContext", () => {
  it("queries NornicDB vector index with graph and metadata filters", async () => {
    runMock.mockResolvedValue({
      records: [
        {
          get(key: string) {
            if (key === "node") {
              return {
                properties: {
                  id: "chunk-1",
                  doc_id: "doc-1",
                  text: "force_new replacement metadata",
                  source_url: "https://example.test/provider",
                  document_name: "provider schema",
                  authority: "vetted",
                  pack: "terraform-latest",
                  symbol_name: "aws_instance",
                  module_path: "provider-schemas/aws.json",
                  content_format: "json",
                  has_code: false,
                  embedding: [0.1, 0.2, 0.3],
                },
              };
            }
            if (key === "score") return 0.9;
            if (key === "neighbors") return [{ properties: { id: "symbol-1" } }];
            if (key === "edge_list") return [{ type: "DEFINES", properties: {} }];
            return undefined;
          },
        },
      ],
    });

    const results = await retrieveContext("terraform force_new drift", baseConfig, {
      topK: 5,
      metadata: {
        pack_id: "terraform-latest",
        symbol_name: "aws_instance",
      },
      version: "v1.14.9",
    });

    expect(driverMock).toHaveBeenCalledWith("bolt://nornic.local:7687", expect.anything());
    expect(sessionMock).toHaveBeenCalledWith({ database: "nornic" });
    expect(runMock).toHaveBeenCalledTimes(1);
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain("CALL db.index.vector.queryNodes($index_name");
    expect(cypher).toContain("node.pack = $pack_id");
    expect(cypher).toContain("node.source_version = $source_version");
    expect(cypher).toContain("[rels:DEFINES|CALLS|IMPORTS*1..2]");
    expect(params).toMatchObject({
      index_name: "embeddings",
      query: "terraform force_new drift",
      pack_id: "terraform-latest",
      symbol_name: "aws_instance",
      source_version: "v1.14.9",
    });
    expect(results[0]?.pack_id).toBe("terraform-latest");
    expect(results[0]?.symbol_name).toBe("aws_instance");
    expect(results[0]?.module_path).toBe("provider-schemas/aws.json");
    expect(results[0]?.content_format).toBe("json");
    expect(results[0]?.retrieval_source).toBe("hybrid");
    expect("embedding" in (results[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("applies exact ACL and scope predicates to seed and graph neighbor nodes", async () => {
    runMock.mockResolvedValue({ records: [] });

    await retrieveContext("private code graph", baseConfig, {
      topK: 3,
      scopeFilter: {
        callerOrgId: "org-1",
        callerTenantIds: ["tenant-1"],
        callerAclGroups: ["team-alpha"],
        callerUserId: "user-1",
        callerConversationId: "chat-1",
        authzMode: "audit",
        authzTraceId: "trace-1",
        trustedScopeSource: "auth_context",
      },
      graphDepth: 2,
    });

    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain('node.visibility_scope = "tenant"');
    expect(cypher).toContain('node.tenant_id IN $caller_tenant_ids');
    expect(cypher).toContain("group IN coalesce(node.acl_group_ids, [])");
    expect(cypher).toContain('split(coalesce(node.acl_groups, ""), ",")');
    expect(cypher).not.toContain('coalesce(node.acl_groups, "") CONTAINS group');
    expect(cypher).toContain("OPTIONAL MATCH path=(node)-[rels:DEFINES|CALLS|IMPORTS*1..2]-(neighbor)");
    expect(cypher).toContain('WHERE ((coalesce(neighbor.visibility_scope, "global") = "global"');
    expect(cypher).toContain("group IN coalesce(neighbor.acl_group_ids, [])");
    expect(params).toMatchObject({
      caller_org_id: "org-1",
      caller_tenant_ids: ["tenant-1"],
      caller_acl_groups: ["team-alpha"],
      caller_user_id: "user-1",
      caller_conversation_id: "chat-1",
    });
  });

  it("post-filters restricted results through OpenFGA in enforce mode", async () => {
    setFgaCheckOverride((_user, _relation, objectType, objectId) => ({
      allowed: objectType === "rag_doc" && objectId === "doc-allow",
      resolution: "test",
    }));
    runMock.mockResolvedValue({
      records: ["doc-allow", "doc-deny"].map((docId) => ({
        get(key: string) {
          if (key === "node") {
            return {
              properties: {
                id: `${docId}:chunk`,
                doc_id: docId,
                text: `content for ${docId}`,
                source_url: "https://example.test/private",
                document_name: docId,
                authority: "vetted",
                visibility_scope: "org",
                org_id: "org-1",
                acl_mode: "private",
                authz_object_id: `rag_doc:${docId}`,
              },
            };
          }
          if (key === "score") return 0.9;
          if (key === "neighbors") return [];
          if (key === "edge_list") return [];
          return undefined;
        },
      })),
    });

    const results = await retrieveContext("private docs", baseConfig, {
      topK: 5,
      scopeFilter: {
        callerOrgId: "org-1",
        callerUserId: "user-1",
        authzMode: "enforce",
        authzTraceId: "trace-enforce",
        trustedScopeSource: "auth_context",
      },
    });

    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.acl_mode, "open") IN ["open", "", "restricted", "private"]');
    expect(results).toHaveLength(1);
    expect(results[0]?.doc_id).toBe("doc-allow");
  });
});

describe("retrieveKnowledgeBundle", () => {
  it("prefers PackCard rows while preserving context_cards compatibility", async () => {
    const record = (values: Record<string, unknown>) => ({
      get(key: string) {
        return values[key];
      },
    });
    const node = (properties: Record<string, unknown>) => ({ properties });

    runMock
      .mockResolvedValueOnce({
        records: [
          record({
            pack_id: "openshift-latest",
            pack_version: "1.0.0",
            source_version: "4.16",
            domain: "openshift",
            content_type: "developer",
            language: "",
            package_name: "",
            trust_score: 1,
            quality_score: 1,
            freshness_score: 1,
            node_count: 12,
            chunk_count: 2,
            example_count: 0,
            context_card_count: 0,
            pack_card_count: 1,
            pattern_count: 0,
            constraint_count: 0,
            edge_count: 5,
            score: 24,
          }),
        ],
      })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({
        records: [
          record({
            node: node({
              id: "openshift-latest:pack-card:route-tls",
              kind: "PackCard",
              name: "OpenShift Route TLS passthrough",
              text: "Use passthrough termination when the backend owns TLS.",
              pack: "openshift-latest",
              domain: "openshift",
              what_to_use: "Route passthrough TLS",
              when_to_use: "Backend service presents the certificate.",
              do_not_use: "Do not set edge-only fields for passthrough.",
              minimal_example: "spec.tls.termination: passthrough",
              verification: "oc explain route.spec.tls",
              claims: "[\"passthrough preserves backend TLS\"]",
              constraints: "[\"backend must terminate TLS\"]",
              evidence_refs: "[\"route.openshift.io/v1 Route spec.tls\"]",
              taxonomy_domains: "openshift,kubernetes",
            }),
            score: 4,
          }),
        ],
      })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] });

    const bundle = await retrieveKnowledgeBundle(
      { query: "OpenShift route TLS passthrough", domain: "openshift", topK: 3 },
      baseConfig,
    );

    expect(bundle.resolved_pack?.pack_id).toBe("openshift-latest");
    expect(bundle.resolved_pack?.pack_card_count).toBe(1);
    expect(bundle.pack_cards).toHaveLength(1);
    expect(bundle.context_cards).toHaveLength(1);
    expect(bundle.context_cards[0]?.what_to_use).toBe("Route passthrough TLS");
    expect(bundle.context_cards[0]?.claims).toContain("passthrough preserves backend TLS");
    expect(bundle.routing).toMatchObject({
      mode: "auto",
      strategy: "single-nornicdb",
      selected_pack_ids: ["openshift-latest"],
    });
    expect(bundle.quality.pack_card_count).toBe(1);
  });
});
