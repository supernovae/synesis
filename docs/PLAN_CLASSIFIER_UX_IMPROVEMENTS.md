# Classifier & UX Improvements Plan

Addresses external feedback on EntryClassifier, routing, and UX. Related: [WORKFLOW.md](WORKFLOW.md), [USERGUIDE.md](USERGUIDE.md).

---

## Summary

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | 1. YAML namespacing | Medium | Prevents silent config loss |
| P0 | 2. Split complexity/risk/domain axes | High | "K8s users not punished" |
| P0 | 5. Thresholds vs weights consistency | Low | Doc/implement alignment |
| P1 | 3. classification_reasons + score_breakdown | Low | Tuning observability |
| P1 | 4. Risk veto before trivial fast-path | Medium | Prevents "curl \| bash" trivial |
| P1 | 6. State semantics + invariant assertions | Medium | Prevents dropped keys |
| P1 | 7. Pending question staleness + mismatch | Medium | Avoids wrong resume |
| P2 | 8. Teach mode clarification budget | Low | UX polish |
| P2 | 9. Progressive friction (extend to routing) | Medium | Feels like tool, not bot |
| P2 | 10a. IntentEnvelope linter | Low | Config regression guard |
| P2 | 10b. /why and /reclassify commands | Low | Power-user tuning |
| P2 | 10c. Confident trivial rule | Low | Length + meta_scope guard |
| P2 | Open WebUI feedback voter | Medium | Feedback loop for tuning |

---

## 1. YAML Structural Foot-Gun (P0)

**Problem:** Multiple `weights:` keys at same level can overwrite (YAML loader behavior). Healthcare plugin weights can silently replace ontology weights.

**Current:** `plugin_weight_loader.py` uses `master_weights.update(plug.get("weights", {}))` — later plugin overwrites same category names. If two plugins both define `weights:`, second file wins for top-level merge. The **plugin** files only have `weights:` and `pairings:` — they're merged explicitly in code. The foot-gun is: if a plugin YAML has duplicate top-level keys (e.g. two `weights:`), yaml.safe_load keeps the last. Also: core `intent_weights.yaml` vs `entry_classifier_weights.yaml` — only one is loaded as base.

**Fix:** Explicit namespacing and compose block.

```yaml
# intent_weights.yaml (base ontology)
ontology:
  v3:
    thresholds: { trivial_max: 4, small_max: 15, density_threshold: 3, density_tax: 10 }
    weights: { io_basic: {...}, ... }
    pairings: [...]

plugins:
  healthcare_compliance:
    weights: { phi_identifiers: {...} }
    pairings: [...]
  # Each plugin namespaced; no top-level key collision

compose:
  enabled_plugins: ["healthcare_compliance"]  # or SYNESIS_ENTRY_CLASSIFIER_PLUGINS
  merge_strategy: "sum"  # sum | max | replace
```

**Code:** Load base ontology, then apply plugin overlays deterministically. No top-level `weights:` at root — everything under `ontology.v3` or `plugins.<name>`.

---

## 2. Split Complexity / Risk / Domain Axes (P0)

**Problem:** "kubectl" → orchestration (20) → complex. Domain vocabulary escalates complexity; breaks "trivial shouldn't get interrogated."

**Current:** Single score; `orchestration` weight 25, `cloud_infra` 20. One word forces complex.

**Fix:** Three independent axes.

| Axis | Purpose | Routing effect |
|------|---------|---------------|
| **complexity_score** | Steps, uncertainty, scope | trivial/small/complex tier |
| **risk_score** | destructive, secrets, compliance, prod | veto → force Supervisor |
| **domain_hints** | k8s/openshift/python/go | RAG gravity, routing metadata only |

**Rules:**
- `risk_score >= RISK_HIGH` → complex (or strict path) regardless of complexity
- `complexity` small/trivial + no risk veto → fast path
- **domain_hints never directly escalate complexity**

**Implementation:**
- Split weights in YAML: `complexity_weights`, `risk_weights`, `domain_keywords`
- `domain_keywords` populate `active_domains` for RAG; no score contribution
- `complexity_weights` (io_basic, logic_basic, data_processing...) — smaller weights, cap single-category
- `risk_weights` (destructive, security, credentials, compliance) — can force escalation
- New fields in IntentEnvelope: `complexity_score`, `risk_score`, `domain_hints`, `task_size` derived from rules above

---

## 3. classification_reasons + score_breakdown (P1)

**Problem:** No explainability; misclassifications require "vibe debugging."

**Fix:** Add to IntentEnvelope (and logs):

```python
classification_reasons: ["pairing(phi+public)", "keyword(hipaa)", "risk_veto(destructive)"]
score_breakdown: { phi_identifiers: 15, pairing_phi_public: 40, complexity_total: 2 }
```

**Code:** ScoringEngine.analyze() already returns `classification_hits`. Extend to:
- `classification_reasons`: list of human-readable strings (e.g. `"pairing(phi+public): +40"`)
- `score_breakdown`: dict category → points

Expose in state, respond metadata, and debug logs. Cursor rule: always include these when emitting IntentEnvelope.

---

## 4. Risk Veto Before Trivial (P1)

**Problem:** "hello world, also curl | bash" matches trivial regex but must not skip Supervisor.

**Fix:** Deterministic risk veto pass **before** declaring trivial.

**Veto triggers (if any match → force Supervisor path):**
- Destructive verbs + prod words
- credentials/secrets words
- "public exposure" words
- network-install: `pip install`, `npm install`, `curl`, `wget`
- compliance: hipaa, phi, pci

**Placement:** After trivial regex match, before setting `task_size=trivial`. If veto hits → treat as small or complex (or run full scoring).

**Config:** Add `risk_veto_keywords` to YAML (or deterministic list in code) so veto is tunable.

---

## 5. Thresholds vs Weights Consistency (P0)

**Problem:** Doc says "Trivial < 5 | Small 5–15 | Complex > 15" but single keyword can score 20–30.

**Fix:**
- **Option A:** Reduce single-category weights; rely on pairings for escalation. e.g. orchestration 8, security 10, destructive 15.
- **Option B:** Move high weights to `risk_weights` only; `complexity_weights` stay 1–8. Complexity never exceeds ~20 from single axis; risk can override.

Recommendation: **Option B** — split axes (item 2) naturally fixes this.

---

## 6. LangGraph State Semantics (P1)

**Problem:** "Keys not included may be dropped"; nested overwrites; reducer gaps.

**Current mitigation:** "Nodes between Worker and Respond must forward generated_code, code_explanation, patch_ops" — pragmatic.

**Better fix:**
- Strongly type state (Pydantic/TypedDict with reducers)
- Add debug assertion: `once worker_output_present=True → generated_code | patch_ops must remain until Respond unless explicitly cleared`
- Consider `synesis_graph_state_invariant` check at graph compile or runtime (dev only)

---

## 7. Pending Question: Staleness + Mismatch (P1)

**Current:** TTL on pending questions.

**Add:**
- **Answer-type validation:** If `expected_answer_types: ["confirm"]` and user replies with paragraph, don't blindly resume. Validate format or treat as new task.
- **Task drift detection:** If reply diverges from stored `task_description` (e.g. embedding similarity < threshold), treat as new entry. Avoid "user answered but also added requirements" wrong resume.

**Implementation:** In `main.py` when restoring pending question, run lightweight drift check. If high divergence → clear pending, route as new task.

---

## 8. Teach Mode Clarification Budget (P2)

**Rule:** Teach mode must not increase interrogation. Same or lower clarification budget; increase explanation depth via Learner's Corner only.

**Code:** EntryClassifier already sets `interaction_mode=teach`. Ensure Supervisor/planner do not increase `clarification_budget` when teach. Add explicit check: `if interaction_mode == "teach": clarification_budget = min(clarification_budget, 1)`.

---

## 9. Progressive Friction (P2)

**Principle:** Default to simple execution; escalate only when necessary.

**Routing rules:**
- Default: simple path
- Escalate when: risk veto, scope ambiguous + budgets allow, sandbox/LSP evidence requires, user requests plan/strict
- Domain never directly escalates

Already partially there (trivial fast path). Extend: ensure "escalation_reason" is set whenever we route to Supervisor/Planner for non-trivial. Cursor rule: any routing escalation must set `escalation_reason: str`.

---

## 10. High-Leverage Additions (P2)

### A) IntentEnvelope Linter

Before any node runs (or at startup): validate config and outputs.
- Required fields exist
- Thresholds consistent with weights (no single keyword > small_max unless risk)
- No duplicate YAML keys (detect via loading and key count check)
- Scoring outputs include `classification_reasons`

Run in tests and optionally in main.py startup if `SYNESIS_ENTRY_CLASSIFIER_LINT=1`.

### B) /why and /reclassify Commands

**/why:** Return `classification_reasons` + `score_breakdown` in response. Power users see why task was classified trivial/small/complex.

**/reclassify small|complex:** Force next run with `task_size` override. Log as tuning candidate (structured log or endpoint for later analysis). Does not persist — single request override.

Implementation: In main.py message filter, detect `/why` or `/reclassify X`. For `/why`, inject last classification from state or re-run classifier and return reasons in a short response. For `/reclassify`, set override in state.

### C) Confident Trivial Rule

Trivial allowed only when:
- score < trivial_max
- no risk veto
- no meta_scope terms (architecture, whole repo, etc.)
- request length < threshold (e.g. 200 chars) — long text often implies scope

Heuristics, not hard limits. Add `max_trivial_message_length` config.

---

## Open WebUI Feedback Voter Integration (P2)

**Goal:** Ingest Open WebUI thumbs-up/thumbs-down into Synesis feedback loop for tuning.

**Open WebUI:** Has feedback API (see Swagger at `/docs`). Feedback is stored per message; can be fetched via API.

**Options:**

1. **Poll Open WebUI API:** Periodic job or cron that calls Open WebUI feedback endpoints, filters by model (`synesis-agent`), and writes to Synesis feedback store (e.g. Milvus `feedback_v1` or CSV/DB).

2. **Webhook from Open WebUI:** If Open WebUI supports webhooks on feedback — configure to POST to Synesis endpoint. Planner exposes `POST /v1/feedback` that stores vote + message_id + run_id.

3. **LiteLLM / Planner passthrough:** When Open WebUI sends feedback, it may go to LiteLLM. Check if we can intercept or if Open WebUI posts separately. If Open WebUI calls its own backend, we need a separate sync job.

4. **Admin dashboard:** Add "Feedback" tab in synesis-admin that:
   - Fetches from Open WebUI API (when configured)
   - Shows thumbs up/down with message slice, classification_reasons, score_breakdown
   - Enables "Add to tuning candidates" for misclassified examples

**Implementation steps:**
1. Document Open WebUI feedback API (Swagger)
2. Create `FeedbackStore` (interface) — in-memory or Milvus
3. Add sync script or webhook: `scripts/sync-openwebui-feedback.sh` or `POST /v1/feedback`
4. Admin UI: list feedback, filter by vote, show classification context
5. Export for tuning: generate YAML patch suggestions from negative feedback clusters

**Schema for stored feedback:**
```python
{
  "message_id": str,
  "run_id": str,
  "vote": "up" | "down",
  "user_id": str,
  "model": str,
  "message_snippet": str,
  "response_snippet": str,
  "classification_reasons": list[str],
  "score_breakdown": dict,
  "task_size": str,
  "timestamp": str,
}
```

---

## Cursor Rule to Add

```markdown
## EntryClassifier Invariants

- EntryClassifier outputs must include: complexity_score, risk_score, domain_hints, classification_reasons
- domain_hints must NEVER directly affect task_size
- Any routing escalation must set escalation_reason (string enum)
- Nodes between Worker and Respond must forward generated_code, code_explanation, patch_ops
```

---

## Implementation Order

1. **Phase 1 (Quick wins):** 3, 10a, 10b — classification_reasons, linter, /why
2. **Phase 2 (Config safety):** 1, 5 — YAML namespacing, split axes (2)
3. **Phase 3 (Safety):** 4, 7 — risk veto, pending question drift
4. **Phase 4 (Polish):** 8, 9, 10c — teach mode, progressive friction, confident trivial
5. **Phase 5 (Feedback):** Open WebUI integration, admin dashboard
