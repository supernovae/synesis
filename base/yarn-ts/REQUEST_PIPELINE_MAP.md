# Yarn Request Pipeline Map

This map traces the production path from inbound chat request to outbound provider call.

## OpenAI Path

1. Ingress + parse  
   - `src/index.ts` `app.post("/v1/chat/completions")`  
   - `src/schemas.ts` `OpenAIChatCompletionRequestSchema.safeParse`
2. Tool/result normalization pipeline  
   - `src/reduction/tool-result-reducer.ts` `reduceMessagesAsync`  
   - `src/validation/service.ts` `normalizeMessagesAsync`  
   - `src/reduction/transcript-pruning.ts` `prune`
3. Enrichment + context assembly  
   - `src/index.ts` `enrichWithFrameAndManifest`  
   - `src/context/stable-prefix.ts` `partition`  
   - `src/context/attention-positioning.ts` `position`  
   - `src/index.ts` `injectSessionContext`  
   - **Optional (off by default):** `src/sensemaking/run-sensemaking.ts` — `SYNESIS_YARN_SENSEMAKING_ENABLED` evaluates gaps/triggers; `SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED` separately controls appending a late `<EXPLORATION_PLAN>` system block (same turn as evidence/pattern prefetch). Keep block injection off until cache impact is validated.
4. Tool/schema assembly  
   - `src/compat/sorted-tools.ts` `sortToolSchemas`  
   - `src/compat/tool-schema-pruning.ts` `pruneToolSchemas`  
   - `src/tool-mapping.ts` `openAIToolsToSDK`, `mapToolChoice`
5. Provider boundary  
   - `src/index.ts` `generateText` / `streamText`  
   - `src/providers/synesis-provider.ts` `resolve` (OpenAI-compatible backend model)
6. Usage + telemetry  
   - `src/index.ts` `readUsage`, `persistSessionAndUsage`  
   - `@synesis/telemetry` trace/metrics emitters

## Claude Path

1. Ingress + parse  
   - `src/index.ts` `app.post("/v1/messages")`  
   - `src/schemas.ts` `ClaudeMessagesRequestSchema.safeParse`
2. Protocol conversion  
   - `src/tool-mapping.ts` `claudeMessagesToOpenAI`, `sanitizeToolCalls`
3. Shared normalization + enrichment + provider boundary  
   - same sequence as OpenAI with Claude-specific tool policy and stop handling

## Mutation Risk Notes

- **Can increase token spend**: enrichment blocks, tool schema expansion, replay loops, server-side tool loops.
- **Can reduce token spend**: tool-result reduction, validation normalization, transcript pruning, schema pruning.
- **Can break prefix stability**: volatile system blocks merged early, tool ordering drift, synthetic IDs, nondeterministic JSON serialization, provider options churn. Qwen3-coder-next prompt includes explicit Plan→Do→Act discipline to reduce interventions.
- **Sensemaking (opt-in)**: default off; enabling classification does not require prompt mutation. Exploration-plan block injection is separately gated and should be enabled only after cache validation.

## Replay Loops

- OpenAI non-stream path can issue up to 3 additional provider calls for server-side tools.
- Claude non-stream path can issue up to 3 additional provider calls when server-side web search is active.
- Each round appends assistant/tool messages and re-sends the full current transcript to the provider.

## Post-Deploy Verification Checklist

- `request_forensics_v1`: LCP ratio should trend upward on coding sessions.
- `request_forensics_v1`: `firstChangedSection=system` frequency should trend downward.
- Session metrics: cache ratio should increase and `tokens_in` growth slope should flatten.
- Session events: with sensemaking off (default), `sensemaking_triggered` is absent. When you enable the flag, expect occasional `sensemaking_triggered` in explore / abstain / high know-better-ratio conditions.

