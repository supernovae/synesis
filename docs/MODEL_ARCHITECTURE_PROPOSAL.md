# Synesis Model Architecture Proposal: Multi-Model JCS with Qwen3

## Executive Summary

Proposal to evolve Synesis from a 2-LLM setup (Supervisor/Critic + Worker) to a 4-LLM setup with distinct roles optimized for JCS (Joint Cognitive System) principles. Key goals:

1. **Reduce user back-and-forth** — System asks for clarification or suggests planning instead of guessing
2. **Structured handoffs** — JSON schema validation between nodes so we don't silently propagate malformed data
3. **Agentic heavy lifter** — Qwen3-Coder-Next for long-context, tool-calling, MoE execution
4. **Preserve JCS/Supervision** — Systems thinker to systems thinker, not "unleash agent and hope"

---

## Proposed Model Lineup

| Role | Model | Rationale | Temp | Context |
|------|-------|-----------|------|---------|
| **Supervisor** | Qwen3-14B | Short curated context, strict schema, deterministic routing. Temp ~0 for reproducible classifications. | 0 | 8–16K |
| **Planner** | Qwen3-14B | Task breakdown, execution_plan (shares Supervisor deployment) | 0.2 | 16K |
| **Executor** | Qwen3-Coder-Next | Agentic, large window, MoE, tool calling. The heavy lifter for code generation. | 0.2 | 64K+ |
| **Critic** | Qwen3-14B-Instruct | Schema + evidence requirements. Same family as Supervisor for consistency. | 0.1 | 8–16K |

**Note on naming:** The current `executor_node` in the graph is the **sandbox** (runs code). We'd introduce an **Executor LLM** node and rename the sandbox step to `sandbox` or `run` for clarity.

---

## Graph Restructure

### Current Flow
```
User → Supervisor → Worker (Qwen Coder) → [Sandbox] → Critic → Response
                          ↑                    |
                          +—— LSP (on failure) —+
```

### Proposed Flow
```
User → Supervisor → [clarification?] → Planner → Executor LLM → Sandbox → Critic → Response
        |                   |              |           |             |
        |                   |              |           |             +—— LSP (on failure) → Planner
        |                   |              |           +—— (tool calls, long context)
        |                   |              +—— Structured plan (steps, open_questions)
        |                   +—— "I need X before I can proceed"
        +—— task_type, needs_clarification, planning_suggested
```

**New routing options from Supervisor:**
- `clarification_needed` → Respond with question to user (no code path)
- `planning_suggested` → Route to Planner first (complex multi-step)
- `worker` (legacy) → Could still go straight to Executor for simple tasks, or always Planner→Executor

---

## JCS Enhancements: Less Back-and-Forth

### 1. Clarification Request

**Problem:** User says "fix the script" — system guesses which script, what's broken.

**Solution:** Supervisor can emit:
```json
{
  "needs_clarification": true,
  "clarification_question": "Which script needs fixing? I see script.sh and deploy.py in your context.",
  "clarification_options": ["script.sh", "deploy.py", "Something else"],
  "confidence": 0.3,
  "next_node": "respond"
}
```

The respond node would surface this as a user-facing question instead of proceeding.

### 2. Planning Checkpoint

**Problem:** Complex tasks get a stream of agentic effort that may diverge.

**Solution:** Planner outputs a structured plan before Executor runs:
```json
{
  "plan": {
    "steps": [
      {"id": 1, "action": "Parse input file", "dependencies": []},
      {"id": 2, "action": "Validate schema", "dependencies": [1]},
      {"id": 3, "action": "Generate report", "dependencies": [2]}
    ],
    "open_questions": ["Should we support JSON and YAML or just JSON?"],
    "assumptions": ["Input is UTF-8 encoded"]
  }
}
```

For `planning_suggested` tasks, we could optionally surface the plan to the user ("Here's my plan — proceed or refine?") or proceed automatically. Configurable.

### 3. Proactive "I Need More"

Executor (Qwen3-Coder-Next) prompt would include:
- "If the task is underspecified, output `needs_input` with a specific question rather than guessing."
- Tool calls for clarification: `ask_user(question, options?)`

### 4. Observability Preserved

Every node still outputs:
- `reasoning`, `assumptions`, `confidence`
- `NodeTrace` for Prometheus/Grafana
- Explicit uncertainty flags: `low_confidence`, `open_questions`

---

## JSON Schema Validator / Formatter

**Why:** Different models produce different "dialects" of JSON. Malformed or incomplete output can cascade.

**What:** A thin middleware (`base/planner/app/schema.py` or similar):

1. **Validation** — Pydantic models per node output (SupervisorOut, PlannerOut, ExecutorOut, CriticOut)
2. **Extraction** — Robust JSON extraction (find `{` ... `}`, handle markdown fences)
3. **Canonicalization** — Normalize field names, coerce types, fill defaults
4. **Retry** — On validation failure: retry with "Your previous output was invalid JSON. Fix: ..." (1 retry)
5. **Fallback** — If retry fails: emit `error` + partial state, route to respond

**Implementation sketch:**
```python
# base/planner/app/schemas.py
class SupervisorOut(BaseModel):
    task_type: TaskType
    task_description: str
    needs_code_generation: bool
    confidence: float
    assumptions: list[str] = []
    # New fields
    needs_clarification: bool = False
    clarification_question: str | None = None
    planning_suggested: bool = False

def parse_and_validate(raw: str, model: type[BaseModel]) -> BaseModel:
    """Extract JSON, validate, return or raise."""
```

Each node would call `parse_and_validate(response.content, SupervisorOut)` instead of ad-hoc `json.loads`.

---

## Prompt Changes (High Level)

### Supervisor (Qwen3-14B)
- Add: "If the request is ambiguous or you lack context, set `needs_clarification: true` and provide `clarification_question`."
- Add: "For multi-step or complex tasks, set `planning_suggested: true`."
- Strict JSON schema; temp 0.

### Planner (Qwen3-14B, shared with Supervisor)
- Input: task_description, RAG context, assumptions from Supervisor
- Output: Structured plan with steps, dependencies, open_questions
- Lightweight — "break this down" not "write code"

### Executor (Qwen3-Coder-Next)
- Input: plan, full context, RAG, failure hints
- Output: code + tool_calls (if using native tool calling), or JSON with code
- "When underspecified, output needs_input instead of guessing."
- Long context — can hold plan + RAG + history

### Critic (Qwen3-14B-Instruct)
- Add: Evidence requirements — "Cite specific line numbers for each concern."
- Stricter schema: `approved`, `revision_feedback`, `what_if_analyses` with required fields

---

## Sizing Considerations

| Model | Params | FP16 VRAM | FP8 VRAM | CPU? |
|-------|--------|-----------|----------|------|
| Qwen3-14B | 14B | ~28 GiB | ~14 GiB | Possible (slow) |
| Qwen3-14B (planner) | 14B | shared with Supervisor | — | Yes |
| Qwen3-Coder-Next | TBD (MoE) | TBD | TBD | Unlikely |
| Embedder | 22M | — | — | Yes |

**Deployment options:**
- **Shared Qwen3-14B**: One deployment for Supervisor + Critic (different system prompts, same model). Saves ~14–28 GiB.
- **Planner**: Shares Qwen3-14B with Supervisor; no separate deployment needed.
- **Qwen3-Coder-Next**: Primary GPU consumer. MoE may reduce active params — need to verify actual VRAM.

**Recommendation:** Qwen3-14B for Supervisor+Planner+Critic (shared). Qwen3-Coder-Next for Executor. Plan for 2 GPUs: one for Executor, one for Qwen3-14B if needed.

---

## Implementation Phases

**Status: Phases 1–5 implemented (2025-02).** Phase 6 (planning checkpoint) optional.

### Phase 1: Schema Validator + Supervisor Clarification ✅
- Add `schemas.py` with Pydantic models for each node output
- Wrap existing JSON parsing in `parse_and_validate`
- Add `needs_clarification` to Supervisor prompt and routing
- No new models yet

### Phase 2: Model Registry Update ✅
- Add Qwen3-14B, Qwen3-Coder-Next to `models.yaml` (planner shares Supervisor)
- Update config for 4 model endpoints
- Deploy and wire endpoints

### Phase 3: Planner Node ✅
- New `planner_node` using Qwen3-14B (shared with Supervisor)
- Supervisor routes to Planner (or directly to Executor for simple tasks)
- Planner outputs structured plan; Executor consumes it

### Phase 4: Executor LLM + Sandbox Rename ✅
- Introduce `executor_llm_node` (Qwen3-Coder-Next) — the code generator
- Rename current `executor_node` → `sandbox_node`
- Graph: Planner → Executor LLM → Sandbox → Critic

### Phase 5: Critic Schema + Evidence ✅
- Update Critic prompt for evidence requirements
- Migration: Critic uses Qwen3-14B-Instruct

### Phase 6: Planning Checkpoint (Optional)
- Surface plan to user for complex tasks
- Config flag: `require_plan_approval_for_complex_tasks`

---

## Open Questions

1. **Qwen3-Coder-Next availability** — HuggingFace repo, quantization support, actual param count (MoE effective size)
2. **Tool calling integration** — Does Executor use native tool/function calling, or JSON-in-prompt? Affects prompt design.
3. **Shared vs separate Qwen3-14B** — Latency vs resource tradeoff
4. **Planning approval** — Always auto-proceed, or optional user approval for `planning_suggested` tasks?

---

## References

- Current graph: `base/planner/app/graph.py`
- State: `base/planner/app/state.py`
- Node implementations: `base/planner/app/nodes/`
- Models: `models.yaml`
