# RAG Retrieval Architecture

Synesis retrieval is graph-native. NornicDB provides the vector index and the
content graph in one backend.

## Query Shape

1. Embed the user query with TEI/BGE-M3.
2. Retrieve seed `ContentNode` matches from the `embeddings` vector index.
3. Apply metadata and authz predicates in Cypher.
4. Expand graph context over code/document relationships.
5. Reapply authz predicates to neighbor nodes.
6. Rerank, boost by authority/freshness, and merge with web evidence if enabled.

## Why Graph-Native Retrieval

Code and operational docs are relationship-heavy. A good answer may need the
chunk that matched semantically, the file that contains it, the symbol it
defines, and nearby imports/calls. Keeping those relationships in NornicDB makes
that context available without forcing an LLM to infer structure from text.

## Security Model

Graph expansion is not a bypass. Seed nodes and neighbor nodes use the same
visibility and ACL predicates. In enforcement mode, protected rows are also
checked with OpenFGA `can_read` against `rag_doc:*` objects.
