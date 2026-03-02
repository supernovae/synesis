# Synesis Intent Taxonomy — "The 95%" Coverage Design

**Role:** Synesis Taxonomy Engineer  
**Goal:** A YAML-driven scoring engine covering 100+ industrial, creative, scientific, and lifestyle verticals.

---

## 1. Schema Rules (Invariants)

### 1.1 Complexity Weights

| Tier | Score | Meaning |
|------|-------|---------|
| **Trivial** | < 5 | Single-step, localized, no state. Fast-path protected. |
| **Small** | 5–15 | Single-step with scope; localized to 1–3 files. |
| **Complex** | > 15 | Multi-step, protocol-heavy, stateful, or architecturally significant. |

- Single category capped ~10 so one keyword cannot force complex.
- **Density tax:** 3+ complexity categories → +10.
- **Trivial anchors (1–2 only):** `io_basic`, `logic_basic`, `query_basic`, `create_basic`.

### 1.2 Risk Weights

| Threshold | Effect |
|-----------|--------|
| **≥ 15** | Veto trivial → complex. Never run Minimalist on high-risk tasks. |

Categories: destructive, security_governance, pii_handling, financial, production_deploy, phi_identifiers, industrial_safety, etc.

### 1.3 Domain Keywords

- **RAG gravity only.** Score = 0. Never escalate complexity.
- Purpose: Route Context Curator to correct collections (kubernetes, healthcare, fintech, etc.).
- **Sovereign intersection:** Multiple domains detected → retrieve from both indices.

### 1.4 Pairings (Synergistic Multipliers)

- **Risk pairings:** `delete` + `database` → +15 risk. `credential` + `log` → +25 risk.
- **Complexity pairings:** `microservices` + `deploy` → +15 complexity.
- Domain-only pairings possible (extra_weight: 0) for disambiguation.

---

## 2. Trivial Fast-Path Protection

Trivial requests (hello world, simple scripts) must stay on the fast path.

| Mechanism | Implementation |
|-----------|----------------|
| **Trivial anchors** | Only `io_basic`, `logic_basic`, `query_basic`, `create_basic` (weight 1–2). |
| **Risk veto** | Substring match on `pip install`, `curl \|`, `\| bash`, `chmod +x`, `rm -rf`, etc. → block trivial. |
| **Length veto** | Messages > `max_trivial_message_length` (200 chars) rarely stay trivial. |
| **Educational discount** | `force_teach` + trivial → clarify path, not escalation. |

**Do NOT** add heavyweight keywords to trivial anchors. Keep `io_basic`, `logic_basic`, `query_basic` minimal.

---

## 3. The 100-Vertical Scope (Coverage Matrix)

### 3.1 Infrastructure

| Vertical | Complexity | Risk | Domain (RAG) | Plugin |
|----------|------------|------|--------------|--------|
| Cloud (AWS/GCP/Azure) | cloud_native, serverless | production_deploy | cloud, aws, gcp, azure | vertical_infrastructure |
| Kubernetes / OpenShift | k8s_ops, orchestration | cluster_destructive | kubernetes, openshift | vertical_infrastructure |
| On-Prem / Bare Metal | scope_expansion | — | on_prem, vmware, proxmox | vertical_infrastructure |
| Networking | networking_infra | — | dns, vpc, nginx | master |
| HPC | hpc_scheduling | — | slurm, mpi, cuda | master + vertical_infrastructure |

### 3.2 Development

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Web (Frontend) | web_ui_basic | — | react, vue, svelte | master |
| Web (Backend) | api_consumer | — | fastapi, django, express | master |
| Systems (C/Rust) | systems_programming | unsafe+prod pairing | rust, go | vertical_development |
| Mobile | mobile_native | — | ios, android, flutter | master + vertical_development |
| Embedded | embedded_realtime | embedded+safety pairing | arduino, iot | master + vertical_development |
| GameDev | gamedev_engine | — | unity, unreal | master + vertical_development |

### 3.3 Compliance

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Healthcare (HIPAA) | interop_standards | phi_identifiers | epic, cerner, hl7, fhir | compliance_healthcare |
| Finance (PCI/SOX) | — | transaction_logic, fin_regulatory | stripe, plaid | compliance_fintech |
| Legal (GDPR/CCPA) | regulatory_workflow | gdpr_privacy | one trust, docusign | vertical_compliance_legal |
| Industrial (ISO) | ot_integration | industrial_safety, iso_compliance | siemens, rockwell | vertical_industrial |

### 3.4 Scientific

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Bioinformatics | bioinformatics_pipeline | clinical_data | fasta, sam, gatk | vertical_scientific |
| Physics Simulation | physics_simulation | — | monte carlo, fem, cfd | vertical_scientific |
| GIS / Geospatial | geospatial_analysis | — | postgis, gdal | vertical_scientific |
| ML-Ops | ml_pipeline | model+production pairing | mlflow, sagemaker | vertical_scientific |

### 3.5 Creative

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Audio Synthesis | signal_flow, synthesis_types | — | oscillator, lfo, daw | domain_audio_synthesis |
| Digital Art | digital_art | — | canvas, shader | vertical_creative |
| Video Editing | video_processing | — | ffmpeg, h264 | vertical_creative |
| Procedural Gen | procedural_generation | — | perlin, l-system | vertical_creative |

### 3.6 Lifestyle

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Biomechanics (Running) | training_metrics | injury+pain pairing | vo2max, marathon | domain_running |
| Nutrition | nutrition_tracking | nutrition+medical pairing | calories, macro | vertical_lifestyle |
| Home Automation | home_automation | home+security pairing | zigbee, mqtt | vertical_lifestyle |
| Personal Finance | personal_finance | financial+export pairing | budget, portfolio | vertical_lifestyle |

### 3.7 Protocols & Cross-Cutting

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Fediverse / ActivityPub | protocol_fediverse | — | mastodon, webfinger | domain_protocols |
| OAuth / OIDC | protocol_auth | — | oauth2 | domain_protocols |
| gRPC / Protobuf | protocol_rpc | — | grpc | domain_protocols |
| AI Governance | compute_infra, model_mgmt | ai_safety | llm safety | ai_governance |
| SecOps / Hardening | — | security_standards | fips, stig | secops_hardening |

---

## 4. Plugin Catalog (Modular Depth)

Plugins add **niche** keywords. The master covers **generic** baseline.

| Plugin | Focus | Complexity Categories | Risk Categories | Domain |
|--------|-------|------------------------|-----------------|--------|
| **compliance_healthcare** | PHI, HL7/FHIR | interop_standards | phi_identifiers | healthcare_systems |
| **compliance_fintech** | PCI, SOX, Ledger | — | transaction_logic, fin_regulatory | fin_platforms |
| **vertical_compliance_legal** | GDPR, e-discovery | regulatory_workflow | gdpr_privacy, legal_sensitive | privacy_tools |
| **vertical_infrastructure** | Cloud, K8s, HPC | cloud_native, k8s_ops, hpc_scheduling | cluster_destructive | aws, gcp, azure, observability |
| **vertical_development** | Systems, Mobile, Embedded | systems_programming, mobile_native | — | rust, go, frontend |
| **vertical_scientific** | Bio, Physics, GIS, ML | bioinformatics_pipeline, physics_simulation, ml_pipeline | clinical_data | genomics, ml_platforms |
| **vertical_industrial** | ISO, OT/SCADA | ot_integration | industrial_safety, iso_compliance | industrial_platforms |
| **vertical_creative** | Video, Art, Procedural | video_processing, procedural_generation | — | creative_media |
| **vertical_lifestyle** | Nutrition, Home, Finance | nutrition_tracking, home_automation | — | smart_home, finance_tools |
| **domain_protocols** | Fediverse, OAuth, gRPC | protocol_fediverse, protocol_auth, protocol_rpc | — | — |
| **domain_audio_synthesis** | Oscillators, Modular | signal_flow, synthesis_types | — | audio_synthesis |
| **domain_running** | VO2max, Taper | training_metrics | injury+pain | athletics |
| **domain_disambiguation** | cluster vs cluster | — | — | kubernetes, healthcare |
| **ai_governance** | LLM safety | compute_infra, model_mgmt | ai_safety | — |
| **secops_hardening** | FIPS, CIS | — | security_standards | — |
| **vertical_aerospace_automotive** | DO-178C, ISO 26262 | flight_software, adas_stack | flight_safety, automotive_safety | avionics, vehicle_ecosystem |
| **vertical_edtech** | LMS, SCORM | lms_integration, learning_analytics | — | lms_platforms, authoring |
| **vertical_llm_rag** | RAG, retrieval, chunking | rag_pipeline, chunking_strategy, reranking | — | llm_rag |
| **vertical_llm_prompting** | Prompt engineering, tool use | prompt_design, tool_use, prompt_injection | — | llm_prompting |
| **vertical_llm_evaluation** | Eval, benchmarks | eval_harness, hallucination, eval_metrics | — | llm_evaluation |
| **ai_governance** | LLM safety, fine-tuning | compute_infra, model_mgmt | ai_safety | ai_governance |

---

## 5. Merge Rules (Plugin Loader)

- **complexity_weights / risk_weights / domain_keywords:** Later plugin overwrites same category name. Use unique names per plugin.
- **pairings:** Append. Plugins add risk/complexity multipliers.
- **overrides:** Per-key merge (force_manual, force_teach, force_pro_advanced).
- **thresholds:** Later overrides base.

---

## 6. Coverage Gaps & Extensions

To reach "the 95%" for new verticals:

1. **Add domain_keywords** in master or plugin (RAG routing only).
2. **Add complexity_weights** for multi-step/protocol-heavy work.
3. **Add risk_weights** for destructive/compliance work (≥15 vetoes trivial).
4. **Add pairings** for synergistic triggers (e.g. `safety` + `override`).

**Example—Aerospace:** Add `domain_keywords.aerospace` (domain: aerospace) with keywords like `dof-178c`, `adas`, `autopilot`. Add `risk_weights.safety_critical` if not covered by industrial.

**Example—EdTech:** Add `domain_keywords.edtech` with `lms`, `scorm`, `canvas`, `moodle`. Complexity only if building full learning platform.

---

## 7. Taxonomy-Driven Explain-Only Routing

For non-programming questions (training plans, meal plans, budgets, etc.), the Entry Classifier emits `intent_class` (e.g. planning, personal_guidance) and `active_domain_refs` (e.g. athletics_running, nutrition). The Supervisor receives these and applies **deterministic passthrough** — no LLM call for routing.

| Condition | Action |
|-----------|--------|
| `intent_class` ∈ (planning, personal_guidance) **and** vertical = lifestyle | Skip Supervisor LLM; route to Worker with `deliverable_type=explain_only`, `allowed_tools=["none"]`, `target_language=markdown` |
| Else | Normal Supervisor LLM routing |

**Flow:** Entry Classifier → Supervisor (passthrough) → Context Curator → Worker (produces markdown) → Patch Integrity Gate (bypass sandbox) → Respond.

**Intent envelope:** When the Supervisor LLM runs, the pre-classified block includes `intent_class` and `active_domain_refs` so it can route planning/personal_guidance + lifestyle requests to `respond` or to Worker with explain_only. Fallback: if `next_node=respond` but `needs_code=false` and task length > 20 chars, force `next_node=worker` with explain_only.

**No explicit listing:** The fix relies on the taxonomy (intent + domain), not enumerating every question type. New lifestyle planning questions (e.g. meditation plan, study schedule) are covered when their keywords match `intent_weights` and domain plugins.

---

## 8. Vertical-Specific Prompting (Sovereign Persona Injection)

**File:** `vertical_prompts.yaml` — Maps `active_domain` → Worker persona, Planner rules, Critic mode.

| Vertical | Worker Persona | Planner Rules | Critic Mode |
|----------|----------------|----------------|-------------|
| medical | HIPAA Compliance Officer | Step 1 = audit log for PHI | safety_ii |
| fintech | Fintech Auditor | Step 1 = audit log for ledger | safety_ii |
| llm_rag | RAG best practices | Step 1 = chunking/retrieval | tiered |
| llm_prompting | Trust boundary, delimiters | Standard atomic | tiered |
| llm_evaluation | Reproducibility, validity | Step 1 = eval set/metric | tiered |
| llm_governance | AI safety, output filter | Step 1 = safety boundary | safety_ii |
| industrial | Safety-Critical | Step 1 = safety boundaries | safety_ii |
| platform | FIPS/OpenShift | Step 1 = FIPS verification | safety_ii |
| scientific | Reproducibility | Verification per step | safety_ii |
| lifestyle | No Safety-II | Standard atomic | tiered (basic/advanced/research) |

**Domain resolution:** `active_domain_refs` (EntryClassifier) + `platform_context` (Strategic Advisor) → canonical vertical.

**Critic tiered mode** (lifestyle, llm_rag, llm_prompting, llm_evaluation): trivial → basic (Advisory), small → advanced (vertical-specific checks), complex → research (comprehensive). LLM verticals: RAG (chunk boundaries, attribution), prompting (injection risk), eval (methodology).

**Intent Class overlay** (critic = base + domain + intent): Knowledge → hallucination-sensitive; Writing → tone-based; Debugging → evidence-required; Review → strict; Data Transform → schema-enforcing; Personal Guidance → safety gate. See [INTENT_TAXONOMY.md](INTENT_TAXONOMY.md).

**Domain-pairing multipliers:** `public` + `patient` → risk +50 (immediate Complex). `phi` + `public` → +40. See compliance_healthcare, compliance_fintech plugins.

---

## 9. Approach + Dark Debt + How I Got Here (Universal)

**File:** `approach_dark_debt_config.yaml` — Maps (intent × vertical × task_size) → approach semantics, dark-debt categories, and evidence sources.

- **Approach:** What we chose to do — e.g. "Quick one-shot answer" (lifestyle trivial) vs "12-week training plan" (lifestyle complex); "RAG-grounded answer" (knowledge).
- **Dark debt:** What we're carrying — e.g. "Quick answer given; ask for full plan if needed" (lifestyle); "Forced approval at max iterations" (code); "RAG confidence low" (knowledge).
- **How I got here:** Taxonomy-aware decision summary — code uses lint/sandbox/LSP/strategy; knowledge uses RAG; lifestyle uses RAG and assumptions.

Surfaced in respond as **How I got here** (Architect) and **What I'm carrying** (any persona when relevant).

---

## 10. Critic Policy Engine (§critic_policy_spec)

The critic follows a **policy engine spec** (`base/planner/critic_policy_spec.json`) that defines:

- **Evidence gating:** Blocking issues MUST cite sandbox or LSP evidence; no speculation.
- **Monotonic retry:** `state.retry` accumulates failures, decisions, diversification history; never loses prior state.
- **Fail-fast:** At `max_iterations`, force PASS (degraded) and emit `dark_debt_signal`.
- **needs_more_evidence:** Emit retrieval query plan; route to Supervisor; do not call tools.

Implementation: `base/planner/app/critic_policy.py` — `check_evidence_gate`, `retry_state_updates`, `should_force_pass`, etc.

---

## 11. See Also

- [critic_policy_spec.json](../base/planner/critic_policy_spec.json) — Critic policy engine spec
- [approach_dark_debt_config.yaml](../base/planner/approach_dark_debt_config.yaml) — Approach + dark debt (universal)
- [intent_weights.yaml](../base/planner/intent_weights.yaml) — Active config (may symlink to master)
- [master_intent_weights.yaml](../base/planner/master_intent_weights.yaml) — Full sovereign catalog
- [vertical_prompts.yaml](../base/planner/vertical_prompts.yaml) — Sovereign persona injection
- [plugins/weights/README.md](../base/planner/plugins/weights/README.md) — Plugin format
- [nodes.md](nodes.md) — Node flow and persona tiers
