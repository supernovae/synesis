# Plan: Remaining JCS Implementation Work

## Clarifications from User

1. **Planner model**: ~~DeepSeek Coder Instruct~~ — now uses Qwen3-14B (shared with Supervisor).
2. **Phase 6**: Implement planning approval when plan has changes. Surface plan, user approves before proceed.
3. **needs_input routing**: Wire Executor (agentic MoE) as the brains — when it outputs `needs_input`, route to respond so user can answer.
4. **No legacy**: Rebuilding for OpenShift AI 3. Use direct model endpoints — synesis-supervisor, synesis-planner, synesis-executor, synesis-critic. No fallback to coder/supervisor.

---

## Task 1: Planner Model ✅

Planner uses Qwen3-14B Instruct (shared with Supervisor). DeepSeek Coder 6.7B deprecated.

---

## Task 2: Phase 6 — Planning Approval ✅

**Behavior**: When `planning_suggested` and Planner produces a non-empty plan, surface it and wait for user approval before proceeding to Worker.

**Implementation**:
1. Config: `require_plan_approval: bool = True` ✅
2. Planner: when `require_plan_approval` and plan has steps, set `next_node = "respond"` (with `plan_pending_approval: true` in state) ✅
3. Respond: when `execution_plan` present + `plan_pending_approval` + no code, format plan, store in memory, return "Here's my plan: [steps]. Reply to proceed or suggest changes." ✅
4. **Persistence**: `store_pending_plan` / `get_and_clear_pending_plan` in conversation memory ✅
5. **Entry routing**: Entry node routes to Worker when `pending_plan_continue` in state (injected by main when restoring plan); else Supervisor ✅

---

## Task 3: needs_input Routing (Executor as Brains) ✅

**Behavior**: When Worker/Executor outputs `needs_input: true` and `needs_input_question`, route to respond — ask the user instead of guessing.

**Implementation**:
1. Worker uses `parse_and_validate(ExecutorOut)` for schema validation ✅
2. When `needs_input` is True, put `needs_input_question` in state; graph routes to respond ✅
3. State: `needs_input_question: str` ✅
4. Respond: when `needs_input_question` and no code, surface "I need more info: {question}", store via `store_pending_needs_input` ✅
5. Graph: Worker conditional edge — if needs_input_question → respond, else → sandbox ✅
6. **Continuation**: When user replies, `get_and_clear_pending_needs_input` restores context; entry routes to Worker with `user_answer_to_needs_input` in prompt ✅

---

## Task 4: Remove Legacy — Direct Model Endpoints ✅

**Changes**:
1. config.py: Defaults point to synesis-supervisor, synesis-planner, synesis-executor, synesis-critic ✅
2. coder_model removed from config ✅
3. deployment.yaml: Env vars for all four models ✅
4. supervisor configmap: Replaced qwen-coder/mistral-nemo with synesis-supervisor, synesis-planner, synesis-executor, synesis-critic ✅
5. models.yaml: Four-model primary lineup, no fallback comments ✅
6. litellm-config.yaml: synesis-agent primary, four models for direct access, no coder fallback ✅
7. model-serving README: Updated deployment and config instructions ✅

---

## Execution Order

1. Task 1 (Planner model) — quick
2. Task 4 (Remove legacy) — config/deployment updates
3. Task 3 (needs_input) — Worker parsing + routing
4. Task 2 (Phase 6) — planning approval (needs memory design)
