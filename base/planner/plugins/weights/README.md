# Intent Weights Plugins

Drop industry-specific "Rules of Law" YAML files here. Synesis absorbs them at startup.

**See [docs/TAXONOMY.md](../../docs/TAXONOMY.md)** for the full Intent Hierarchy and 95% coverage design.

## Taxonomy Overview ("The 95%")

The core `intent_weights.yaml` (v4) is a **Global Sovereign Catalog** covering 100+ verticals:

| Sector | Complexity Categories | Risk Categories | Domains (RAG) |
|--------|----------------------|-----------------|---------------|
| **Infrastructure** | scope_expansion, distributed_systems | production_deploy | cloud, kubernetes, hpc, networking |
| **Development** | web_ui_basic, api_consumer, testing_suite | security_governance | web_frontend, web_backend, mobile, embedded, gamedev |
| **Compliance** | — | pii_handling, financial, destructive | — |
| **Scientific** | stateful_logic | — | bioinformatics, geospatial, ml_ops |
| **Creative** | — | — | creative_media, procedural |
| **Lifestyle** | — | — | home_automation, personal_finance, nutrition |

**Routing logic:** Trivial <5 | Small 5–15 | Complex >15. Risk ≥15 vetoes to complex. Domain keywords only influence RAG retrieval, never complexity.

## Format (v3/v4)

Use `complexity_weights`, `risk_weights`, and `domain_keywords`. Domain never escalates complexity.

### complexity_weights

Steps, scope, technical complexity. Single category capped ~10.

```yaml
complexity_weights:
  interop_standards:
    weight: 12
    keywords: ["hl7", "fhir", "emr", "ehr"]
```

### risk_weights

Destructive ops, secrets, compliance. Can veto trivial → complex.

```yaml
risk_weights:
  phi_identifiers:
    weight: 15
    domain: healthcare_compliance
    keywords: ["phi", "patient", "hipaa"]
```

### domain_keywords

RAG gravity only. Never contributes to score.

```yaml
domain_keywords:
  healthcare_systems:
    domain: healthcare_compliance
    keywords: ["epic", "cerner", "meditech"]
```

### pairings

```yaml
pairings:
  - keywords: ["phi", "public"]
    extra_weight: 40
    axis: risk   # or complexity
  - keywords: ["cluster", "pod"]
    domain: kubernetes
    extra_weight: 0   # domain-only, no score
```

## Merge Rules

- **complexity_weights / risk_weights / domain_keywords**: Later plugins override same category names.
- **pairings**: Append (plugins add risk multipliers + domain disambiguators).
- **overrides**: Per-key merge.
- **thresholds**: Later overrides.

## Sovereign Intersection

When two high-gravity verticals are detected (e.g. HIPAA + K8s), both domains are tracked. The Context Curator retrieves RAG from both indices.

## Plugin Catalog

| Plugin | Focus | Complexity | Risk | Domain |
|--------|-------|------------|------|--------|
| `domain_protocols.yaml` | Fediverse, ActivityPub, OAuth, gRPC | protocol_fediverse, protocol_auth, system_build | — | — |
| `compliance_healthcare.yaml` | PHI, HL7/FHIR, Epic/Cerner | interop_standards | phi_identifiers | healthcare_systems |
| `compliance_fintech.yaml` | Ledger, PCI-DSS, SOX, KYC/AML | — | transaction_logic, fin_regulatory | fin_platforms |
| `vertical_compliance_legal.yaml` | GDPR, CCPA, e-discovery | regulatory_workflow | gdpr_privacy, legal_sensitive | privacy_tools, legal_tech |
| `secops_hardening.yaml` | FIPS, CIS, STIGs, SELinux | — | security_standards, os_hardening | — |
| `ai_governance.yaml` | LLM safety, bias, Blackwell/GPU | compute_infra, model_mgmt | ai_safety | — |
| `vertical_infrastructure.yaml` | Cloud, K8s, HPC, on-prem | cloud_native, k8s_ops, hpc_scheduling | cluster_destructive | aws, gcp, azure, observability |
| `vertical_development.yaml` | Web, Systems, Mobile, Embedded, GameDev | systems_programming, mobile_native, gamedev_engine | — | rust, go, frontend, backend |
| `vertical_scientific.yaml` | Bioinformatics, Physics, GIS, ML-Ops | bioinformatics_pipeline, physics_simulation, ml_pipeline | clinical_data | genomics, geospatial |
| `vertical_industrial.yaml` | ISO, Industrial IoT, OT/SCADA | ot_integration, manufacturing_workflow | industrial_safety, iso_compliance | industrial_platforms |
| `vertical_creative.yaml` | Video, Digital Art, Procedural Gen | video_processing, procedural_generation | — | creative_media, procedural |
| `vertical_lifestyle.yaml` | Nutrition, Home Auto, Personal Finance | nutrition_tracking, home_automation, personal_finance | — | nutrition, smart_home, finance |
| `domain_audio_synthesis.yaml` | Oscillators, LFO, modular, DAW | signal_flow, synthesis_types, gear_specific | — | audio_synthesis |
| `domain_running.yaml` | VO2max, biomechanics, marathon taper | training_metrics, biomechanics, programming | injury+pain pairing | athletics |
| `domain_disambiguation.yaml` | cluster+pod vs cluster+patient | — | — | kubernetes, healthcare, databases |
| `vertical_aerospace_automotive.yaml` | DO-178C, ISO 26262, ADAS | flight_software, adas_stack | flight_safety, automotive_safety | avionics, vehicle_ecosystem |
| `vertical_edtech.yaml` | LMS, SCORM, learning analytics | lms_integration | — | lms_platforms, authoring |
| `vertical_llm_rag.yaml` | RAG, retrieval, chunking | rag_pipeline, chunking_strategy | — | llm_rag |
| `vertical_llm_prompting.yaml` | Prompt engineering, tool use | prompt_design, tool_use | prompt_injection | llm_prompting |
| `vertical_llm_evaluation.yaml` | Eval, benchmarks, hallucination | eval_harness, hallucination | — | llm_evaluation |
| `ai_governance.yaml` | LLM safety, fine-tuning | compute_infra, model_mgmt | ai_safety | ai_governance |

**Sovereign intersection:** When two verticals are detected (e.g. HIPAA + K8s), both domains are tracked. Context Curator retrieves RAG from both indices.

## Trivial Fast-Path Protection

Trivial requests (hello world, simple scripts) stay on the fast path. Protected by:

- **Trivial anchors** (weight 1–2): `io_basic`, `logic_basic`, `query_basic` only
- **Risk veto triggers** (substring match): `pip install`, `curl \|`, `\| bash`, `chmod +x`, etc. → block trivial
- **Length veto**: Messages >200 chars rarely stay trivial
- **Density tax**: 3+ complexity categories hit → +10 complexity

See `intent_weights.yaml` and `master_intent_weights.yaml` for the full catalog.
