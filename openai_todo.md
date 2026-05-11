# OpenAI Compatibility Todo

Track OpenAI-compatible capabilities we want Synesis to expose, and the native Synesis backing each should use. Compatibility should be pragmatic: implement surfaces that client tools expect, but keep routing, authz, storage, retrieval, and model selection native to Synesis/admin configuration.

## Principles

- [ ] Keep model/provider configuration in the admin Models & Costs Registry.
- [ ] Avoid hardcoded hidden model roles; expose every internal model role in admin.
- [ ] Prefer Synesis-native implementations behind OpenAI-compatible endpoints.
- [ ] Scope all persistent resources by org/user/tenant and enforce authz consistently.
- [ ] Emit traces and usage for every compatibility endpoint.
- [ ] Do not implement high-risk tool surfaces without a dedicated sandbox and policy layer.

## Already In Progress / Implemented

- [x] Planner supports OpenAI Chat Completions at `POST /v1/chat/completions`.
- [x] Planner accepts modern Chat Completions options such as tools, `response_format`, `reasoning_effort`, `parallel_tool_calls`, `seed`, `stop`, and sampling controls.
- [x] Yarn supports OpenAI Chat Completions at `POST /v1/chat/completions`.
- [x] Yarn exposes `GET /v1/models`.
- [x] Yarn exposes `GET /v1/models/{model}`.
- [x] Yarn has a first-pass `POST /v1/responses` shim over Chat Completions.

## Priority 1: Responses API

- [ ] Add `POST /v1/responses` to planner.
- [ ] Map Responses `input` into planner chat messages.
- [ ] Map Responses `instructions` into leading system/developer context.
- [ ] Map Responses `text.format` into Chat Completions `response_format`.
- [ ] Map Responses `reasoning.effort` into configured `reasoning_effort`.
- [ ] Return OpenAI-like response objects with `output`, `output_text`, `usage`, `status`, and `metadata`.
- [ ] Add SSE event compatibility for streamed Responses.
- [ ] Add conformance tests for OpenAI Agents/SDK-style Responses payloads.

## Priority 2: Native Responses Tools

- [ ] Support OpenAI-style `web_search` tool requests.
  - Backing: existing planner `/v1/web/search`.
  - Enforce: source attribution, web search policy, rate limits, tracing.
- [ ] Support OpenAI-style `file_search` tool requests.
  - Backing: NornicDB vector/RAG retrieval.
  - Enforce: org/user/tenant scope filters and metadata filters.
- [ ] Return tool-call output in Responses-compatible item shapes.
- [ ] Add tests for tool call request/response parity.
- [ ] Defer `computer_use` and code interpreter until there is a dedicated sandbox.

## Priority 3: Files API

- [ ] Add scoped `POST /v1/files`.
- [ ] Add `GET /v1/files`.
- [ ] Add `GET /v1/files/{file_id}`.
- [ ] Add `DELETE /v1/files/{file_id}`.
- [ ] Add `GET /v1/files/{file_id}/content`.
- [ ] Store file metadata in admin DB.
- [ ] Store file content in object/blob storage or a configured durable backend.
- [ ] Support initial file purposes:
  - [ ] `user_data`
  - [ ] `assistants`
  - [ ] `vision`, only for image-understanding workflows
- [ ] Defer unsupported purposes unless needed:
  - [ ] `fine-tune`
  - [ ] `batch`
- [ ] Add malware/content scanning hook before indexing.
- [ ] Add file retention and deletion policy.

## Priority 4: Vector Stores API

- [ ] Add scoped `POST /v1/vector_stores`.
- [ ] Add `GET /v1/vector_stores`.
- [ ] Add `GET /v1/vector_stores/{vector_store_id}`.
- [ ] Add `DELETE /v1/vector_stores/{vector_store_id}`.
- [ ] Add vector-store file attach/detach endpoints.
- [ ] Use admin DB for vector store metadata.
- [ ] Use NornicDB for chunks, embeddings, graph relations, and vector search.
- [ ] Implement ingestion state:
  - [ ] queued
  - [ ] processing
  - [ ] completed
  - [ ] failed
- [ ] Add per-vector-store ACL and tenant scope.
- [ ] Add tests for file ingestion, retrieval, deletion, and authz isolation.

## Priority 5: Multimodal Model Roles

- [ ] Add explicit admin model roles:
  - [ ] `vision`
  - [ ] `image_generation`
  - [ ] `video_generation`
  - [ ] `speech`
  - [ ] `transcription`
  - [ ] `realtime`
- [ ] Add short admin UI descriptions for each role.
- [ ] Ensure no multimodal role falls back silently to `general`/`writer`.
- [ ] Add role assignment health checks that fail closed when keys are missing.

## Priority 6: Images

- [ ] Decide whether Synesis should expose OpenAI-compatible image generation endpoints.
- [ ] If yes, add image generation routing through an `image_generation` model role.
- [ ] Do not use `vision` for image generation; vision is for image understanding.
- [ ] Add request validation for size, format, count, and safety policy.
- [ ] Store generated artifacts with trace IDs and usage metadata.

## Priority 7: Audio

- [ ] Decide whether Synesis should expose OpenAI-compatible transcription endpoints.
- [ ] Route transcription through a `transcription` model role.
- [ ] Decide whether Synesis should expose OpenAI-compatible speech/TTS endpoints.
- [ ] Route TTS through a `speech` model role.
- [ ] Add file size, content type, and retention policy.

## Priority 8: Realtime

- [ ] Do not implement Realtime directly inside planner.
- [ ] Design a dedicated realtime gateway for WebRTC/WebSocket/SIP-style sessions.
- [ ] Reuse admin model role `realtime`.
- [ ] Reuse planner/Yarn policy and tracing where practical.
- [ ] Add session lifecycle, token minting, and connection authz.

## Priority 9: Unsupported / Explicitly Deferred

- [ ] Batch API compatibility.
- [ ] Fine-tuning API compatibility.
- [ ] Code interpreter without sandboxing.
- [ ] Computer-use tools without sandboxing and explicit policy gates.
- [ ] Full OpenAI platform clone behavior where Synesis has no native backing.

## Open Questions

- [ ] Which storage backend should hold uploaded file bytes?
- [ ] Should vector stores be global, org-scoped, project-scoped, or user-scoped by default?
- [ ] Should OpenWebUI and Yarn call planner `file_search`, or should Yarn also expose the same vector-store API directly?
- [ ] Which image generation provider/model should be assigned to `image_generation`?
- [ ] Which speech/transcription providers should be supported first?
- [ ] What retention defaults should apply to files and generated artifacts?
