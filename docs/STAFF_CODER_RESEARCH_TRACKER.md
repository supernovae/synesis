# Staff Coder Research Tracker

Purpose: track what we implemented, why it exists, and the research evidence behind the "staff/principal engineer" agent behavior target.

This file is intentionally practical, not perfection-seeking. We optimize for measurable behavior improvement and low-friction developer experience.

## North Star

- Deliver a "staff engineer" coding experience:
  - handles work end-to-end by default
  - verifies and repairs instead of deferring avoidable work to the user
  - stays scoped and safe
  - reports clearly when blocked
- Avoid "perfection loops":
  - no infinite cleanup
  - bounded retries
  - explicit stop conditions and escalation

## Decision Principles

- Minimal patch, not minimal quality.
- "Done" means request + blocking quality gates, not only compile success.
- Prefer deterministic harness rules over bigger prompts.
- Keep behavior additive and backward-compatible.
- Use telemetry to decide, not vibes.

## Current Implementations (completed)

## 1) Structured diagnostics + tactical repair context

- Status: done
- Implemented in:
  - `base/yarn-ts/src/mcp/handlers/command-diagnostics.ts`
  - `base/yarn-ts/src/mcp/handlers/coding-tools.ts`
  - `base/yarn-ts/tests/command-diagnostics.test.ts`
  - `base/yarn-ts/tests/mcp-tools.test.ts`
- What shipped:
  - `run_*` tools emit `summary`, `errorLines`, `errors[]` (structured diagnostics), capped streams.
  - `apply_patch` emits recovery anatomy (`ok`, `reason`, `suggestedNextActions`, `contextHint`).
- Why this matters:
  - Enables targeted fixes (file/line/message) instead of full-log token thrash.

## 2) Workflow guidance for disciplined execution

- Status: done
- Implemented in:
  - `base/yarn-ts/src/adapters/client-adapter-packs.ts`
  - `base/yarn-ts/src/verification/planner.ts`
- What shipped:
  - Stronger workflow guidance: search/read before edit, patch-over-write preference, verify ordering.
  - Verification plan wording emphasizes lint/build before tests when applicable.
- Why this matters:
  - Reduces "minimum viable patch then stop" behavior.

## 3) Trajectory telemetry for learning loop

- Status: done
- Implemented in:
  - `base/yarn-ts/src/index.ts`
  - `base/yarn-ts/src/mcp/index.ts`
  - `base/admin/app/services/yarn_service.py`
  - `base/admin/frontend/src/api/hooks.ts`
  - `base/admin/frontend/src/pages/yarn/YarnOverview.tsx`
- What shipped:
  - `request_trajectory_v1` events with tool sequence, verification, edit pattern, and outcomes.
  - Parser coverage emission in trajectory verification:
    - `structured_errors_count`
    - `diagnostic_lines_count`
    - `structured_error_coverage`
  - Admin exposure of key behavior metrics:
    - first-pass verify rate
    - verification stall rate
    - blind retry rate
    - patch ratio
    - structured parser coverage
    - trajectory bucket distribution
- Why this matters:
  - Gives objective feedback loop for prompt/tool/policy tuning.

## In Progress / Next

## A) Parser depth expansion

- C2: Python parser expansion (pytest + traceback) - done.
- C3: Rust parser expansion (cargo/rustc) - done.
- Goal:
  - increase structured parser coverage and reduce generic retries.

## B) Staff-behavior enforcement layer

- Implemented:
  - completion gate blocks finalize on blocking quality failures
  - bounded proactive cleanup pass guidance
  - deterministic pre-finalization critic with optional LLM fallback
  - planner/tool contract alignment for Go/TS/Python MCP preset pathways
- Goal:
  - make "complete + clean + verified" the cheapest path.

## Research Basis (papers, docs, and practical systems)

**Centralized arXiv / model reports:** [AWESOME_PAPERS.MD](AWESOME_PAPERS.MD) (sections on routing, context, models, and agent-coding writeups).

## Primary evidence

- SWE-agent (NeurIPS 2024): interface design (ACI) strongly affects agent engineering performance.
  - Source: https://openreview.net/forum?id=30hggYAY0Z
- Qwen3-Coder blog: emphasizes tool-use protocols, long-horizon agent RL, and execution-verified coding tasks.
  - Source: https://qwenlm.github.io/blog/qwen3-coder/
- OpenAI Codex long-horizon guidance: durable plan-implement-verify-repair loop and explicit "done when" files.
  - Source: https://developers.openai.com/blog/run-long-horizon-tasks-with-codex
- Codex best practices: reusable durable guidance (`AGENTS.md` style), clear done criteria, and review/verification loops.
  - Source: https://developers.openai.com/codex/learn/best-practices

## Supporting practical patterns

- Aider lint/test loop:
  - auto lint/test and fix loop after edits
  - explicit handling of formatter-vs-lint behavior
  - Source: https://aider.chat/docs/usage/lint-test.html
- OpenHands critic pattern:
  - iterative refinement with threshold and bounded max iterations
  - Source: https://docs.openhands.dev/sdk/guides/critic

## How we interpret the research here

- We are not trying to imitate any one product surface.
- We are adopting shared high-signal patterns:
  - better interface contracts
  - stronger completion contract
  - verify/repair loops
  - bounded critic/refinement
  - durable operational memory

## Anti-Perfection Guardrails

- Max verification rounds and budget remain bounded.
- One bounded cleanup pass after primary fix.
- If still blocked, return explicit "not complete" state with next actions.
- Track intervention cost:
  - token budget
  - retries
  - latency
  - stall rate
- Reject any change that improves "quality strictness" but degrades user throughput without KPI support.

## KPI Set (for this initiative)

- first_pass_verify_rate (up by bucket)
- tokens_to_green_p90 (down)
- patch_ratio (micro/repo) >= 0.60 target
- structured_error_coverage (up by language)
- verification_stall_rate (down)
- blind_retry_rate (down)
- completion_gate_blocked_rate (new, once gate lands)
- critic_block_rate (new, once critic lands)

## Weekly Update Template

- Week:
- What shipped:
- Hypothesis tested:
- KPI movement:
- Regressions observed:
- Decision:
  - continue / adjust / rollback
- Next chunk:

## Links to active execution docs

- `docs/CODER_AGENT_ITERATION_PLAYBOOK.md` (implementation chunks and resume commands)
- `docs/clients/YARN_KPI_ALERT_PACK.md` (SQL alert/query pack for KPI monitoring)
- `.cursor/plans/staff-coder_behavior_uplift_b5f5e18c.plan.md` (plan artifact)
