# Yarn TS Sawtooth Architecture (Node 22 + AI SDK Core)

This document defines the first-pass TypeScript orchestration architecture for Yarn, using Vercel AI SDK Core with a direct `customProvider` dependency and Synesis-specific policy layers.

## Token Efficiency Model

Without consolidation, context growth is approximately linear:

$$
C_t = C_0 + \sum_{i=1}^{t}\Delta_i \in O(n)
$$

With sawtooth checkpointing and pruning every \(k\) tool steps:

$$
C_t \le C_{max} \approx C_{active} + C_{checkpoint} \in O(1)
$$

where:
- \(C_{active}\): bounded active working set,
- \(C_{checkpoint}\): compressed architectural state block.

## Runtime Layers

1. **Protocol Layer**  
   OpenAI-compatible and Claude-compatible endpoints validate payloads via Zod.

2. **Provider Layer (AI SDK Core)**  
   `customProvider` maps Synesis tier IDs to upstream OpenAI-compatible providers.

3. **State Layer (Sawtooth Context Manager)**  
   Maintains active trajectory, checkpoint decisions, and compression outputs.

4. **Safety Layer**  
   Repeat-loop pivot protocol and patch-first enforcement.

## Sawtooth Checkpointing Rules

- Trigger consolidation every 10-12 tool calls, or earlier on logic milestones.
- Summarize recent trajectory into a strict `<ARCHITECTURAL_STATE>` block.
- Replace verbose logs with masked form:
  - keep first 10 and last 10 lines,
  - suppress middle payload.

## Extension-Based Heuristics

Language-specific log and artifact handling is extension-driven, not framework-driven.
The baseline includes common extensions (TS/JS/Python/Go/Rust/Java/Terraform/SQL/YAML, etc.) and can be extended per domain.

## Safety Fencing

- N-repeat guard on normalized `(tool, args, fsFingerprint)` triplets.
- On 3 repeats without filesystem mutation, force Hard Pivot strategy response.
- Reject full-file `write_file` style operations in favor of `apply_patch`/search-replace for non-trivial edits.

## Compatibility Goals

- Keep admin as source of truth for model/provider metadata.
- Preserve tier IDs and client-facing model contract (`synesis-pulse`, `synesis-core`, `synesis-horizon`).
- Maintain MCP compatibility and streaming behavior parity over time.
