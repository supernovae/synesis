# Anemic Supervisor Implementation Plan

**Goal:** Move from Reasoning to Routing. Eliminate 90s timeout on protocol-heavy tasks (Fediverse, ActivityPub) by delegating complex classification to the deterministic EntryClassifier and bypassing the Supervisor LLM when EntryClassifier already says "complex."

---

## Current State

| Component | Behavior | Bottleneck |
|-----------|----------|------------|
| **EntryClassifier** | YAML ScoringEngine → task_size (trivial/small/complex) | No protocol triggers; fediverse/client scores via generic "networking" (8) |
| **route_after_entry_classifier** | trivial→context_curator; else→**supervisor** | Complex always hits Supervisor LLM |
| **Supervisor** | Full LLM, huge prompt, routes to planner/worker | 90s timeout on complex protocol tasks |
| **Planner** | Has execution_plan, plan_pending_approval | Already step-based |
| **Worker** | Uses execution_plan.steps | Already step-aware |
| **Prefix caching** | `--enable-prefix-caching` | Already enabled ✓ |

---

## Phase 1: Protocol Triggers (YAML Plugin)

**Mechanism:** Add `plugins/weights/domain_protocols.yaml` with high-weight complexity keywords. No code changes—existing ScoringEngine absorbs it.

**Result:** Fediverse query hits protocol keywords → complexity_score ≥ 25 → `task_size=complex` (small_max=15).

---

## Phase 2: Supervisor Passthrough for Complex

**Problem:** Even when `task_size=complex`, we route to Supervisor first. The Supervisor LLM call is the 90s bottleneck.

**Fix (Option B — Passthrough):** At top of `supervisor_node`, if `task_size=complex` and `plan_required=True`, return a stub immediately without calling the LLM. Set `next_node=planner`, `task_description` from messages, etc.

**Alternative (Option A — Direct Route):** In `route_after_entry_classifier`, when `task_size=complex` and `plan_required`, route to `context_curator` (for RAG) then `planner`. Requires Planner to work with state from EntryClassifier + Context Curator (no Supervisor fields). More invasive.

**Chosen: Option B** — Minimal change, preserves Supervisor contract. EntryClassifier must set `task_description` for complex (like trivial) so passthrough has it. Planner gets full state.

---

## Phase 3: EntryClassifier — task_description for Complex

When `task_size=complex`, set `task_description = last_content[:500]` so Supervisor passthrough (and Planner) have it. EntryClassifier already does this for trivial.

---

## Phase 4: Plan Approval "Proceed" (Deferred)

User says "Proceed" after plan. Requires conversation memory to persist `plan_pending_approval` and `execution_plan` across turns. Separate effort.

---

## Phase 5: Cursor Rules (Optional)

Add `.cursor/rules/anemic-supervisor.mdc` documenting the constitution for AI assistants.

---

## Phase 6: Slim Supervisor Prompt (Optional)

When Supervisor *does* run (small/ambiguous), use a slimmer prompt. Defer; routing fix alone addresses the timeout.

---

## Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Protocol triggers | ✅ Done | `plugins/weights/domain_protocols.yaml` added |
| 2. Supervisor passthrough | ✅ Already present | `supervisor_node` lines 211-256 |
| 3. task_description for complex | N/A | Passthrough uses `user_context` from messages |
| 4. Plan approval "Proceed" | Deferred | Requires conversation memory |
| 5. Cursor rules | ✅ Already present | `synesis-constitution.mdc` |
| 6. Slim Supervisor prompt | Deferred | |

---

## Robustness: No Infinite Routing

- **Deterministic first:** EntryClassifier (regex + YAML weights) is the source of truth. No LLM for triage.
- **Tunable via YAML:** `domain_protocols.yaml` can be edited without code changes. Add `oauth`, `grpc`, etc.
- **Thresholds:** `trivial_max`, `small_max`, `risk_high` in intent_weights.yaml control escalation.
- **Single bypass rule:** `task_size=complex` + `plan_required` → Supervisor passthrough. No branching tree.
