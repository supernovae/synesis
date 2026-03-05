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

**Routing logic:** Easy <5 | Medium 5–15 | Hard >15. Risk ≥15 vetoes to hard. Domain keywords only influence RAG retrieval, never complexity. Routing thresholds (bypass_supervisor_below, plan_required_above, critic_required_above) live in `routing_thresholds` section of `intent_weights.yaml`.

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

## Plugin Catalog (41 files)

**Compliance (4):** compliance_healthcare, compliance_fintech, compliance_ai_governance, compliance_secops

**Technology (7):** vertical_infrastructure, vertical_development, vertical_programming_slc, vertical_iac_automation, vertical_industrial, vertical_aerospace_automotive, vertical_compliance_legal

**AI/ML (3):** vertical_llm_rag, vertical_llm_prompting, vertical_llm_evaluation

**Science (1):** vertical_scientific

**Education (2):** vertical_education_learning, vertical_edtech

**Business (1):** vertical_business_commerce (includes entrepreneurship, freelancing)

**Health & Wellness (1):** vertical_health_wellness (includes skincare, first aid, aging)

**Fitness & Sports (1):** vertical_fitness (includes martial arts, dance, team sports)

**Food & Cooking (1):** vertical_food_cooking (includes beverages, dietary patterns, preservation)

**Creative & Media (2):** vertical_creative (includes illustration, graphic design, crafts), vertical_music_audio (production, podcasting, DJ)

**Culture & Humanities (1):** vertical_culture_history (includes film/TV, literature, theater, religion, linguistics)

**Hobbies & Making (1):** vertical_hobbies_activities (includes leatherworking, cosplay)

**Family & Pets (2):** vertical_parenting_family, vertical_pets_animals

**Home & Living (1):** vertical_home_improvement (includes interior design, organization, smart home)

**Automotive (1):** vertical_automotive (includes motorcycles, EVs)

**Personal Development (1):** vertical_personal_development (career, productivity, leadership)

**Gaming (1):** vertical_gaming (video games, game design, esports)

**Writing (1):** vertical_writing_publishing (creative writing, publishing, journalism)

**Lifestyle (4):** vertical_events_planning, vertical_fashion_style, vertical_relationships, vertical_sustainability

**Finance & Legal (2):** vertical_real_estate, vertical_personal_legal

**Safety (1):** vertical_safety_emergency

**Domain (2):** domain_protocols, domain_disambiguation

**Sovereign intersection:** When two verticals are detected (e.g. HIPAA + K8s), both domains are tracked. Context Curator retrieves RAG from both indices.

## Easy Fast-Path Protection

Easy requests (hello world, simple scripts) stay on the fast path. Protected by:

- **Easy anchors** (weight 1–2): `io_basic`, `logic_basic`, `query_basic` only
- **Risk veto triggers** (substring match): `pip install`, `curl \|`, `\| bash`, `chmod +x`, etc. → block easy
- **Length veto**: Messages > `max_easy_message_length` (200 chars) rarely stay easy
- **Density tax**: 3+ complexity categories hit → +10 complexity

See `intent_weights.yaml` and `master_intent_weights.yaml` for the full catalog.
