# Synesis Intent Taxonomy — "The 95%" Coverage Design

**Role:** Synesis Taxonomy Engineer  
**Goal:** A YAML-driven scoring engine covering 100+ industrial, creative, scientific, and lifestyle verticals.

---

## 1. Schema Rules (Invariants)

### 1.1 Complexity Weights

| Tier | Score | Meaning |
|------|-------|---------|
| **Easy** | < 5 | Single-step, localized, no state. Fast-path protected. |
| **Medium** | 5–15 | Single-step with scope; localized to 1–3 files. |
| **Hard** | > 15 | Multi-step, protocol-heavy, stateful, or architecturally significant. |

- Single category capped ~10 so one keyword cannot force hard.
- **Density tax:** 3+ complexity categories → +10.
- **Easy anchors (1–2 only):** `io_basic`, `logic_basic`, `query_basic`, `create_basic`.

### 1.2 Risk Weights

| Threshold | Effect |
|-----------|--------|
| **≥ 15** | Veto easy → hard. Never run Minimalist on high-risk tasks. |

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

## 2. Easy Fast-Path Protection

Easy requests (hello world, simple scripts) must stay on the fast path.

| Mechanism | Implementation |
|-----------|----------------|
| **Easy anchors** | Only `io_basic`, `logic_basic`, `query_basic`, `create_basic` (weight 1–2). |
| **Risk veto** | Substring match on `pip install`, `curl \|`, `\| bash`, `chmod +x`, `rm -rf`, etc. → block easy. |
| **Length veto** | Messages > `max_easy_message_length` (200 chars) rarely stay easy. |
| **Educational discount** | `force_teach` + easy → clarify path, not escalation. |

**Do NOT** add heavyweight keywords to easy anchors. Keep `io_basic`, `logic_basic`, `query_basic` minimal.

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
| Astronomy | astronomy_analysis | — | telescope, spectroscopy, cosmology, stellar | vertical_scientific |
| Physics | physics_general, physics_numerical | — | thermodynamics, quantum, fem, cfd | vertical_scientific |
| Mathematics | math_numerical, math_symbolic | — | linear algebra, sympy, optimization | vertical_scientific |
| Statistics | statistics_analysis | — | regression, bayesian, time series | vertical_scientific |
| Chemistry | chemistry_compute | — | molecular, rdkit, cheminformatics | vertical_scientific |
| Social Studies | social_science | survey_pii | sociology, economics, psychology, survey | vertical_scientific |
| Environmental | environmental_science | — | climate, ecology, biodiversity | vertical_scientific |
| Neuroscience | neuroscience | — | fmri, eeg, cognitive | vertical_scientific |
| Materials Science | materials_science | — | dft, crystal, alloy | vertical_scientific |
| Bioinformatics | bioinformatics_pipeline | clinical_data | fasta, sam, gatk | vertical_scientific |
| GIS / Geospatial | geospatial_analysis | — | postgis, gdal | vertical_scientific |
| ML-Ops | ml_pipeline | model+production pairing | mlflow, sagemaker | vertical_scientific |

Planning, writing, personal_guidance with these domains → document output (study plans, essays, reports).

### 3.5 Creative

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Audio Synthesis | signal_flow, synthesis_types | — | oscillator, lfo, daw | vertical_audio_synthesis |
| Digital Art | digital_art | — | canvas, shader | vertical_creative |
| Video Editing | video_processing | — | ffmpeg, h264 | vertical_creative |
| Procedural Gen | procedural_generation | — | perlin, l-system | vertical_creative |

### 3.6 Lifestyle

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Biomechanics (Running) | training_metrics | injury+pain pairing | vo2max, marathon | vertical_fitness |
| Nutrition | nutrition_tracking | nutrition+medical pairing | calories, macro | vertical_lifestyle |
| Home Automation | home_automation | home+security pairing | zigbee, mqtt | vertical_lifestyle |
| Personal Finance | personal_finance | financial+export pairing | budget, portfolio | vertical_lifestyle |

### 3.7 Protocols & Cross-Cutting

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| Fediverse / ActivityPub | protocol_fediverse | — | mastodon, webfinger | domain_protocols |
| OAuth / OIDC | protocol_auth | — | oauth2 | domain_protocols |
| gRPC / Protobuf | protocol_rpc | — | grpc | domain_protocols |
| AI Governance | compute_infra, model_mgmt | ai_safety | llm safety | compliance_ai_governance |
| SecOps / Hardening | — | security_standards | fips, stig | compliance_secops |

### 3.8 Business & Commerce

Aligned with markets: SMB, enterprise, startup, B2B, B2C, consumer. Planning, writing, personal_guidance in these domains → document output (business plans, budgets, marketing strategy, financial reports).

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| **Business Strategy** | business_strategy, business_operations | — | business, markets | vertical_business_commerce |
| **Sales** | sales_crm, sales_forecasting | — | sales, crm | vertical_business_commerce |
| **Marketing** | marketing_campaign, marketing_analytics | — | marketing | vertical_business_commerce |
| **Budgets (Personal)** | budget_personal | — | budget | vertical_business_commerce |
| **Budgets (Business)** | budget_business | budget_override | budget | vertical_business_commerce |
| **Personal Finance** | personal_finance | financial_sensitive | personal_finance | vertical_business_commerce, vertical_lifestyle |
| **Business Finance / FP&A** | business_finance | financial_sensitive | business_finance | vertical_business_commerce |
| **Accounting** | accounting | financial_sensitive | accounting | vertical_business_commerce |

**Market alignment:** `domain_keywords.markets` → SMB, enterprise, startup, SaaS, ecommerce, marketplace. RAG routing for business ops distinct from `compliance_fintech` (PCI, SOX, ledger transactions).

### 3.9 Hobbies & Activities

Broad coverage from outdoors to making to obscure interests. `vertical_fitness` covers athletics (marathon, vo2max). Planning, writing, personal_guidance in these domains → document output (trip plans, gear guides, project how-tos).

| Vertical | Complexity | Risk | Domain | Plugin |
|----------|------------|------|--------|--------|
| **Outdoors** (Hiking, Camping, Paddling) | hiking_backpacking, camping_outdoors, paddling | outdoor_safety | outdoors | vertical_hobbies_activities |
| **Fishing** | fishing | — | fishing | vertical_hobbies_activities |
| **Climbing** | climbing | — | outdoors | vertical_hobbies_activities |
| **Skiing / Snowsports** | skiing_snowsports | outdoor_safety | recreation | vertical_hobbies_activities |
| **Cycling** (Mountain, Gravel, Touring) | cycling_outdoor | — | recreation | vertical_hobbies_activities |
| **Gardening** | gardening | — | gardening | vertical_hobbies_activities |
| **3D Printing** | three_d_printing | — | three_d_printing | vertical_hobbies_activities |
| **Woodworking** | woodworking | power_tools | woodworking | vertical_hobbies_activities |
| **Metalworking / Welding** | metalworking | power_tools | hobbies_making | vertical_hobbies_activities |
| **Electronics Hobby** | electronics_hobby | — | hobbies_making | vertical_hobbies_activities |
| **Sewing / Crafts** | sewing_crafts | — | hobbies_making | vertical_hobbies_activities |
| **Pottery / Ceramics** | pottery_ceramics | — | hobbies_making | vertical_hobbies_activities |
| **Collecting** | collecting | — | hobbies_collecting | vertical_hobbies_activities |
| **Board Games / TTRPG** | board_games | — | board_games | vertical_hobbies_activities |
| **Photography** (hobby) | photography_hobby | — | photography_hobby | vertical_hobbies_activities |
| **Aquariums** | aquariums | — | aquariums | vertical_hobbies_activities |
| **Drones / FPV** | drones | — | recreation | vertical_hobbies_activities |
| **Other** (Golf, Ham Radio, Genealogy, Homebrewing, etc.) | golf, ham_radio, genealogy, homebrewing | — | recreation, hobbies_general | vertical_hobbies_activities |

**Catch-all:** `hobbies_general` routes obscure interests (hobby, pastime, leisure). RAG can retrieve from broad collections when specific domain not indexed.

---

## 4. Plugin Catalog (41 plugins)

Plugins add **niche** keywords. The master covers **generic** baseline. Files live in `base/planner/plugins/weights/`.

### Compliance (4)

| Plugin | Focus | Risk |
|--------|-------|------|
| **compliance_healthcare** | PHI, HL7/FHIR | phi_identifiers |
| **compliance_fintech** | PCI, SOX, Ledger | transaction_logic |
| **compliance_ai_governance** | LLM safety, fine-tuning | ai_safety |
| **compliance_secops** | FIPS, CIS, STIG | security_standards |

### Technology & Infrastructure (7)

| Plugin | Focus |
|--------|-------|
| **vertical_infrastructure** | Cloud (AWS/GCP/Azure), K8s, HPC, on-prem |
| **vertical_development** | Web, Systems, Mobile, Embedded, GameDev |
| **vertical_programming_slc** | 14 language ecosystems, SLC phases |
| **vertical_iac_automation** | Terraform, Ansible, Pulumi, Shell |
| **vertical_industrial** | ISO, Industrial IoT, OT/SCADA |
| **vertical_aerospace_automotive** | DO-178C, ISO 26262, ADAS |
| **vertical_compliance_legal** | GDPR, CCPA, e-discovery |

### AI & ML (3)

| Plugin | Focus |
|--------|-------|
| **vertical_llm_rag** | RAG, retrieval, chunking |
| **vertical_llm_prompting** | Prompt engineering, tool use |
| **vertical_llm_evaluation** | Eval, benchmarks, hallucination |

### Education (2)

| Plugin | Focus |
|--------|-------|
| **vertical_education_learning** | Study, vocabulary, tutoring, study skills, homeschool |
| **vertical_edtech** | LMS, SCORM, learning analytics |

### Business & Commerce (1)

| Plugin | Focus |
|--------|-------|
| **vertical_business_commerce** | Business, Sales, Marketing, Budgets, Finance, Entrepreneurship, Freelancing |

### Science (1)

| Plugin | Focus |
|--------|-------|
| **vertical_scientific** | Bio, Physics, Astronomy, Math, Chemistry, Earth Science, ML-Ops |

### Health & Wellness (1)

| Plugin | Focus |
|--------|-------|
| **vertical_health_wellness** | Health, mental health, sleep, skincare, weight management, first aid, aging |

### Fitness & Sports (1)

| Plugin | Focus |
|--------|-------|
| **vertical_fitness** | Running, strength, yoga, cycling, martial arts, dance, team sports |

### Food & Cooking (1)

| Plugin | Focus |
|--------|-------|
| **vertical_food_cooking** | Recipes, baking, food science, beverages, dietary patterns, preservation |

### Creative & Media (2)

| Plugin | Focus |
|--------|-------|
| **vertical_creative** | Video, digital art, procedural gen, illustration, graphic design, crafts |
| **vertical_music_audio** | Synthesis, music production, podcasting, DJ performance |

### Culture & Humanities (1)

| Plugin | Focus |
|--------|-------|
| **vertical_culture_history** | History, geography, travel, music, art, philosophy, film/TV, literature, theater, religion, linguistics |

### Hobbies & Making (1)

| Plugin | Focus |
|--------|-------|
| **vertical_hobbies_activities** | Outdoors, making, collecting, tabletop, photography, leatherworking, cosplay |

### Family & Pets (2)

| Plugin | Focus |
|--------|-------|
| **vertical_parenting_family** | Parenting, pregnancy, child development, family activities |
| **vertical_pets_animals** | Dogs, cats, training, equestrian, birds, aquatic pets |

### Home & Living (1)

| Plugin | Focus |
|--------|-------|
| **vertical_home_improvement** | DIY repair, renovation, interior design, organization, smart home |

### Automotive (1)

| Plugin | Focus |
|--------|-------|
| **vertical_automotive** | Car maintenance, motorcycles, EVs, restoration |

### Personal Development (1)

| Plugin | Focus |
|--------|-------|
| **vertical_personal_development** | Career, productivity, public speaking, leadership |

### Entertainment (1)

| Plugin | Focus |
|--------|-------|
| **vertical_gaming** | Video games, game design, esports |

### Writing & Publishing (1)

| Plugin | Focus |
|--------|-------|
| **vertical_writing_publishing** | Creative writing, self-publishing, journalism, blogging |

### Lifestyle (4)

| Plugin | Focus |
|--------|-------|
| **vertical_events_planning** | Weddings, parties, event coordination |
| **vertical_fashion_style** | Fashion, wardrobe, grooming |
| **vertical_relationships** | Dating, marriage, communication skills |
| **vertical_sustainability** | Green living, renewable energy |

### Finance & Legal (2)

| Plugin | Focus |
|--------|-------|
| **vertical_real_estate** | Home buying/selling, mortgages |
| **vertical_personal_legal** | Consumer legal, insurance, personal taxes |

### Safety (1)

| Plugin | Focus |
|--------|-------|
| **vertical_safety_emergency** | Emergency preparedness, home safety |

### Domain (2)

| Plugin | Focus |
|--------|-------|
| **domain_protocols** | Fediverse, OAuth, gRPC |
| **domain_disambiguation** | cluster vs cluster, etc. |

---

## 5. Merge Rules (Plugin Loader)

- **complexity_weights / risk_weights / domain_keywords:** Later plugin overwrites same category name. Use unique names per plugin.
- **pairings:** Append. Plugins add risk/complexity multipliers.
- **overrides:** Per-key merge (force_manual, force_teach, force_pro_advanced).
- **thresholds:** Later overrides base. YAML keys: `easy_max`, `medium_max`, `max_easy_message_length`. Routing thresholds live in `routing_thresholds` section of `intent_weights.yaml` (bypass_supervisor_below, plan_required_above, critic_required_above).

---

## 6. Coverage Gaps & Extensions

To reach "the 95%" for new verticals:

1. **Add domain_keywords** in master or plugin (RAG routing only).
2. **Add complexity_weights** for multi-step/protocol-heavy work.
3. **Add risk_weights** for destructive/compliance work (≥15 vetoes easy).
4. **Add pairings** for synergistic triggers (e.g. `safety` + `override`).

**Example—Aerospace:** Add `domain_keywords.aerospace` (domain: aerospace) with keywords like `dof-178c`, `adas`, `autopilot`. Add `risk_weights.safety_critical` if not covered by industrial.

**Example—EdTech:** Add `domain_keywords.edtech` with `lms`, `scorm`, `canvas`, `moodle`. Complexity only if building full learning platform.

---

## 7. Taxonomy-Driven Output Path (needs_sandbox)

**Design: document-first.** Default to discussions, plans, explanations. Code/sandbox path only when taxonomy or coding client signals code. `needs_sandbox` (bool): `false` = text/document (explain), `true` = code/sandbox.

| Mechanism | Intents | Meaning |
|-----------|---------|---------|
| `inherently_document: true` | conversation, knowledge, creative_ideation | Always `needs_sandbox=false` (greetings, explanations, ideas). |
| `document_domains: [...]` | planning, personal_guidance, writing | Intent + domain overlap → `needs_sandbox=false`. |
| **Code intents** | debugging, review, code_generation, data_transform, tool_orchestrated | Explicit code/sandbox path (`needs_sandbox=true`). |
| **Coding client** | (header detection) | Cursor, Claude Code, etc. send `User-Agent`/`X-Client`. Ambiguous (general) → code bias. |

| Intent | Config | Example |
|--------|--------|---------|
| conversation | inherently_document | "hi", "what can you do", "thanks" |
| knowledge | inherently_document | "explain marathon taper", "what is VO2max" |
| creative_ideation | inherently_document | "brainstorm names", "suggest workouts" |
| planning | document_domains | "marathon plan", "meal plan", "budget plan" |
| personal_guidance | document_domains | "how can I improve running", "optimize nutrition" |
| writing | document_domains | "write blog about marathon", "draft email about nutrition" |
| debugging, review, code_generation, data_transform, tool_orchestrated | code | "fix this bug", "write a script", "parse json" |

**No match (general)** → `needs_sandbox=false`. **Coding client + general** → code (Cursor/Claude Code session assumes code).

**Flow:** Entry Classifier (engine, coding_client override) → when `needs_sandbox=false`: if domain in `deep_dive_domains` and `complexity_score > 0.6` → `plan_required=true` → Planner; else → `plan_required=false` → Supervisor passthrough → Worker (explain) → Respond.

**Planner** serves code decomposition and document deep-dive (physics, astronomy, mathematics, etc.). Worker explain path uses a document-focused prompt; when Planner ran for document, Worker receives `taxonomy_metadata` depth block.

---

## 8. Vertical-Specific Prompting (Sovereign Persona Injection)

**File:** Vertical prompts are now embedded in taxonomy plugin YAMLs (e.g. `plugins/weights/vertical_health_wellness.yaml`). Maps `active_domain` → Worker persona, Planner rules, Critic mode.

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

**Critic tiered mode** (lifestyle, llm_rag, llm_prompting, llm_evaluation): easy → basic (Advisory), medium → advanced (vertical-specific checks), hard → research (comprehensive). LLM verticals: RAG (chunk boundaries, attribution), prompting (injection risk), eval (methodology).

**Intent Class overlay** (critic = base + domain + intent): Knowledge → hallucination-sensitive; Writing → tone-based; Debugging → evidence-required; Review → strict; Data Transform → schema-enforcing; Personal Guidance → safety gate. See [INTENT_TAXONOMY.md](INTENT_TAXONOMY.md).

**Domain-pairing multipliers:** `public` + `patient` → risk +50 (immediate Complex). `phi` + `public` → +40. See compliance_healthcare, compliance_fintech plugins.

---

## 9. Approach + Dark Debt + How I Got Here (Universal)

Carried uncertainties are now inlined in `carried_uncertainties.py`. Evidence sources are inlined in `decision_summary.py`.

- **Approach:** What we chose to do — e.g. "Quick one-shot answer" (lifestyle easy) vs "12-week training plan" (lifestyle hard); "RAG-grounded answer" (knowledge).
- **Carried uncertainties:** What we're carrying (known unknowns we surface) — e.g. "Quick answer given; ask for full plan if needed" (lifestyle); "Forced approval at max iterations" (code); "RAG confidence low" (knowledge).
- **How I got here:** Taxonomy-aware decision summary — code uses lint/sandbox/LSP/strategy; knowledge uses RAG; lifestyle uses RAG and assumptions.

Surfaced in respond as **How I got here** (Architect) and **What I'm carrying** (any persona when relevant).

---

## 10. Critic Policy Engine (§critic_policy_spec)

The critic follows a **policy engine spec** (`base/planner/critic_policy_spec.json`) that defines:

- **Evidence gating:** Blocking issues MUST cite sandbox or LSP evidence; no speculation.
- **Monotonic retry:** `state.retry` accumulates failures, decisions, diversification history; never loses prior state.
- **Fail-fast:** At `max_iterations`, force PASS (degraded) and emit `carried_uncertainties_signal`.
- **needs_more_evidence:** Emit retrieval query plan; route to Supervisor; do not call tools.

Implementation: `base/planner/app/critic_policy.py` — `check_evidence_gate`, `retry_state_updates`, `should_force_pass`, etc.

---

## 11. Coverage Gaps & 95% Strategy

### Missing Classifications (Now Addressed)

| Gap | Plugin / Addition | Purpose |
|-----|-------------------|---------|
| **IaC / Automation** | `vertical_iac_automation.yaml` | Terraform (basic vs module/state), Ansible (playbook vs roles), Pulumi, Chef, Puppet. Shell: bash, zsh, ksh, PowerShell. Complexity tiers for `terraform plan` (6) vs `terraform module + state` (10). |
| **Programming languages** | `vertical_programming_slc.yaml` | Python, JS/TS, Go, Rust, Java, C#, Ruby, PHP, Elixir, Perl, Lua, Scala, Haskell. Ecosystem terms: pip, npm, cargo, maven, etc. RAG routing to language-specific collections. |
| **Shell variants** | Entry classifier + IaC plugin | zsh, ksh, korn shell, PowerShell (.ps1, pwsh) in language detection. domain: shell_bash, powershell. |
| **SLC phases** | vertical_programming_slc | requirements_phase, design_phase, testing_phase, deployment_phase, maintenance_phase, documentation_artifact. Enables phase-aware routing (e.g. design → document; implement → code). |
| **Migration / Documentation** | intent_classes | `migration` (migrate, upgrade, deprecate, version bump), `documentation` (generate docs, readme, api docs). Code intents for artifact generation. |

### Complexity Interpretation

| User says | Intended | Taxonomy behavior |
|-----------|----------|-------------------|
| "terraform plan" | Medium (single command) | terraform_basic (6) → medium ✓ |
| "terraform module for vpc" | Medium–hard | terraform_module (10) + scope → medium or hard ✓ |
| "ansible playbook for 50 hosts" | Hard | ansible_orchestration (12) + multi → hard ✓ |
| "bash script to backup db" | Medium | shell_scripting (6) + local_persistence (8) → medium ✓ |
| "simple hello world" | Easy | io_basic (1), create_basic (1) → easy ✓ |
| "migrate from Python 2 to 3" | Hard | maintenance_phase (10) + migration intent → hard ✓ |

**Density tax:** 3+ complexity categories → +10. Prevents single keyword from dominating; reflects real multi-faceted tasks.

**Risk veto:** Any risk ≥15 → force hard. Security, destructive, production deploy never easy.

### How Taxonomy Improves Nodes

| Node | Use |
|------|-----|
| **Critic** | vertical_programming_slc → migration/dependency risks; vertical_iac_automation → state safety, idempotency |
| **Router / Supervisor** | domain_keywords → route to correct RAG; code_intents → code path; SLC phases → design doc vs implementation |
| **Planner** | SLC phases → step ordering (design before implement); IaC → terraform plan before apply |
| **Executor** | language + ecosystem domain → correct runner (pytest, jest, go test); shell variant → bash vs pwsh |

---

## 12. Taxonomy-RAG Alignment

**Principle:** Taxonomy domain IDs = catalog `domain` field = RAG filter. Single source of truth.

| Layer | Convention |
|-------|------------|
| **Taxonomy** | `domain_keywords.athletics` → `domain: athletics_running`. Add `music` with subdomains `music_piano`, `music_synthesizer` as separate entries. |
| **Indexers** | Tag chunks with `domain=<taxonomy_id>` when upserting. `sources.yaml` or indexer config: use taxonomy domain IDs (e.g. `domain: music_piano`). |
| **RAG client** | `select_collections_for_task` builds `domain in ["athletics_running", "music"]` from `active_domain_refs`. Milvus vector search applies filter. |

**Adding a new vertical (e.g. music):**
1. Add `domain_keywords.music_piano` in a plugin with `domain: music_piano`, keywords like `piano`, `keyboard`.
2. Add `domain_keywords.music_synthesizer` with `domain: music_synthesizer`, keywords like `synth`, `oscillator`.
3. Index music docs with `domain="music_piano"` or `domain="music_synthesizer"` in catalog schema.
4. RAG will filter by `active_domain_refs` when user query matches.

Existing indexers (domain, architecture, code) use their own domain extraction (e.g. `domain_openshift` → `openshift`). Align by configuring indexer `domain` to match a taxonomy ID where applicable.

---

## 13. taxonomy_metadata and Taxonomy Prompt Config

**Purpose:** Router (Entry Classifier) labels topic complexity; `TaxonomyPromptFactory` shapes prompts for Planner and Executor without adding new LLMs. Config-driven depth and structure.

**File:** `base/planner/taxonomy_prompt_config.yaml` — Maps taxonomy keys (physics, astronomy, mathematics, etc.) to `path`, `complexity`, `persona`, `depth_instructions`, `required_elements`. `deep_dive_domains` list: document questions in these domains get `plan_required=true` when `complexity > 0.6`.

**State:** `taxonomy_metadata` (TaxonomyNode) flows through graph: `path`, `complexity_score` (normalized 0.0–1.0), `persona_instructions`, `required_bullets`, `required_elements`, `depth_instructions`, `taxonomy_key`. High-complexity domains trigger Planner with 5 detailed bullets; low complexity uses 1–2.

**Flow:** Entry Classifier → `resolve_taxonomy_metadata()` → `taxonomy_metadata` in state. Planner appends `required_elements` + `depth_instructions` when complexity > 0.7. Worker appends `get_executor_depth_block()`.

See [TAXONOMY_DRIVEN_INJECTION.md](TAXONOMY_DRIVEN_INJECTION.md) for design, flow, and usage.

---

## 14. See Also

- [TAXONOMY_DRIVEN_INJECTION.md](TAXONOMY_DRIVEN_INJECTION.md) — Taxonomy metadata, Planner deep-dive, depth block injection
- [TAXONOMY_CANONICAL.md](TAXONOMY_CANONICAL.md) — Canonical domains, verticals, seeding
- [prompt_taxonomy.yaml](../base/planner/prompt_taxonomy.yaml) — Router → prompt components
- [critic_policy_spec.json](../base/planner/critic_policy_spec.json) — Critic policy engine spec
- carried_uncertainties.py — Carried uncertainties (inlined)
- [intent_weights.yaml](../base/planner/intent_weights.yaml) — Active config (may symlink to master)
- [master_intent_weights.yaml](../base/planner/master_intent_weights.yaml) — Full sovereign catalog
- Vertical prompts in taxonomy plugin YAMLs — Sovereign persona injection
- [plugins/weights/README.md](../base/planner/plugins/weights/README.md) — Plugin format
- [nodes.md](nodes.md) — Node flow and persona tiers
