# Canonical Taxonomy Reference

**Role:** Single source of truth for domain IDs, verticals, and aliases across Synesis.

Use this when editing `intent_weights.yaml`, `vertical_prompts.yaml`, plugins under `plugins/weights/`, and `approach_dark_debt_config.yaml`. Refactor existing files toward these conventions over time.

---

## 1. Canonical Domain IDs

Domain IDs are used for:
- **RAG routing** — `domain` filter in Milvus/vector search
- **Entry classifier** — `active_domain_refs` / `active_domains`
- **Document vs code** — `document_domains` in intent_classes

| Domain ID | Category | Plugin | Notes |
|-----------|----------|--------|-------|
| **Technology & Infrastructure** | | | |
| cloud | platform | vertical_infrastructure | AWS, GCP, Azure |
| kubernetes | platform | vertical_infrastructure | k8s, openshift |
| databases | generic | intent_weights | sql, postgres, redis |
| networking | generic | intent_weights | dns, vpc, nginx |
| hpc | generic | intent_weights | slurm, mpi, cuda |
| web_frontend | generic | vertical_development | react, vue, svelte |
| web_backend | generic | vertical_development | fastapi, django |
| mobile | generic | intent_weights | ios, android |
| embedded | generic | intent_weights | arduino, iot |
| gamedev | generic | intent_weights | unity, unreal |
| terraform | generic | vertical_iac_automation | IaC |
| ansible | generic | vertical_iac_automation | config mgmt |
| shell_bash, powershell | generic | vertical_iac_automation | shell |
| python | generic | vertical_programming_slc | stdlib, pip, venv |
| javascript | generic | vertical_programming_slc | node, npm, esm |
| typescript | generic | vertical_programming_slc | tsc, tsconfig |
| java | generic | vertical_programming_slc | jdk, maven, gradle |
| golang | generic | vertical_programming_slc | go mod, go test |
| rust | generic | vertical_programming_slc | cargo, clippy |
| csharp | generic | vertical_programming_slc | dotnet, nuget, aspnet |
| cpp | generic | vertical_programming_slc | cmake, gdb, lldb |
| c | generic | vertical_programming_slc | gcc, make, gdb |
| php | generic | vertical_programming_slc | composer, artisan |
| ruby | generic | vertical_programming_slc | bundler, rubygems, rspec |
| docker | platform | vertical_infrastructure | dockerfile, compose, images |
| **Science** | | | |
| astronomy | scientific | vertical_scientific | telescope, cosmology |
| physics | scientific | vertical_scientific | thermodynamics, quantum |
| mathematics | scientific | vertical_scientific | linear algebra, sympy |
| chemistry | scientific | vertical_scientific | molecular, rdkit |
| social_science | scientific | vertical_scientific | sociology, economics |
| environmental_science | scientific | vertical_scientific | climate, ecology |
| neuroscience | scientific | vertical_scientific | fmri, cognitive |
| materials_science | scientific | vertical_scientific | dft, crystal |
| ml_ops | scientific | vertical_scientific | tensorflow, mlflow |
| bioinformatics | scientific | vertical_scientific | fasta, sam, gatk |
| geospatial | scientific | vertical_scientific | postgis, gdal |
| **AI & ML** | | | |
| llm_rag | llm | vertical_llm_rag | rag, retrieval |
| llm_prompting | llm | vertical_llm_prompting | prompting |
| llm_evaluation | llm | vertical_llm_evaluation | eval, benchmark |
| ai_governance | llm | compliance_ai_governance | llm safety |
| **Compliance** | | | |
| healthcare_compliance | medical | compliance_healthcare | phi, hipaa |
| fintech_compliance | fintech | compliance_fintech | pci, stripe |
| secops | platform | compliance_secops | fips, stig, cis |
| **Industrial** | | | |
| industrial | industrial | vertical_industrial | scada, plc |
| aerospace | industrial | vertical_aerospace_automotive | avionics, do-178 |
| automotive | industrial | vertical_aerospace_automotive | adas, can bus |
| **Business & Commerce** | | | |
| business | business | vertical_business_commerce | business strategy |
| sales | business | vertical_business_commerce | crm, forecasting |
| marketing | business | vertical_business_commerce | campaigns |
| budget | business | vertical_business_commerce | capex, opex |
| personal_finance | business | vertical_business_commerce | budget, portfolio |
| business_finance | business | vertical_business_commerce | p&l, balance sheet |
| accounting | business | vertical_business_commerce | ledger, journal |
| markets | business | vertical_business_commerce | saas, ecommerce |
| entrepreneurship | business | vertical_business_commerce | startup, founder, mvp |
| freelancing | business | vertical_business_commerce | gig, contract work |
| **Education** | | | |
| education | education | vertical_education_learning | study, vocabulary |
| language_learning | education | vertical_education_learning | duolingo, conjugation |
| test_prep | education | vertical_education_learning | sat, gre prep |
| study_skills | education | vertical_education_learning | spaced repetition, anki |
| homeschool | education | vertical_education_learning | curriculum, montessori |
| edtech | education | vertical_edtech | lms, scorm |
| **Health & Wellness** | | | |
| health | wellness | vertical_health_wellness | symptoms, supplements |
| mental_health | wellness | vertical_health_wellness | anxiety, therapy |
| sleep | wellness | vertical_health_wellness | insomnia, circadian |
| physical_therapy | wellness | vertical_health_wellness | rehab, mobility |
| skincare | wellness | vertical_health_wellness | moisturizer, retinol |
| weight_management | wellness | vertical_health_wellness | calorie deficit, bmi |
| first_aid | wellness | vertical_health_wellness | cpr, wound, burn |
| aging_senior | wellness | vertical_health_wellness | mobility, caregiver |
| **Fitness & Sports** | | | |
| athletics_running | fitness | vertical_fitness | marathon, vo2max |
| fitness_general | fitness | vertical_fitness | workout, gym |
| yoga_pilates | fitness | vertical_fitness | asana, vinyasa |
| cycling | fitness | vertical_fitness | ftp, peloton |
| swimming | fitness | vertical_fitness | freestyle, lap swim |
| strength_training | fitness | vertical_fitness | powerlifting, 1rm |
| martial_arts | fitness | vertical_fitness | bjj, boxing, mma |
| dance | fitness | vertical_fitness | ballet, salsa, zumba |
| team_sports | fitness | vertical_fitness | soccer, basketball |
| **Food & Cooking** | | | |
| cooking | food | vertical_food_cooking | recipe, meal prep |
| baking | food | vertical_food_cooking | sourdough, pastry |
| food_science | food | vertical_food_cooking | fermentation, maillard |
| beverages | food | vertical_food_cooking | coffee, cocktails, wine |
| dietary_patterns | food | vertical_food_cooking | vegan, keto, paleo |
| food_preservation | food | vertical_food_cooking | canning, fermenting |
| **Creative & Media** | | | |
| creative_media | creative | vertical_creative | video editing, obs |
| procedural | creative | vertical_creative | perlin, l-system |
| creative_ml | creative | vertical_creative | stable diffusion, midjourney |
| illustration | creative | vertical_creative | animation, comic, manga |
| graphic_design | creative | vertical_creative | typography, branding |
| crafts_diy_art | creative | vertical_creative | calligraphy, origami |
| **Music & Audio** | | | |
| audio_synthesis | music | vertical_music_audio | oscillator, lfo, synth |
| music_production | music | vertical_music_audio | mixing, mastering, daw |
| podcasting | music | vertical_music_audio | podcast, audio editing |
| dj_performance | music | vertical_music_audio | beatmatching, serato |
| **Culture & Humanities** | | | |
| history | culture | vertical_culture_history | ancient, medieval |
| geography | culture | vertical_culture_history | continent, topography |
| travel | culture | vertical_culture_history | itinerary, destination |
| music | culture | vertical_culture_history | song, album, genre |
| art | culture | vertical_culture_history | painting, sculpture |
| philosophy | culture | vertical_culture_history | ethics, stoicism |
| film_tv | culture | vertical_culture_history | movie, cinema, anime |
| literature | culture | vertical_culture_history | novel, author, poetry |
| theater | culture | vertical_culture_history | broadway, opera, ballet |
| religion_spirituality | culture | vertical_culture_history | buddhism, theology |
| linguistics | culture | vertical_culture_history | etymology, dialect |
| **Hobbies & Making** | | | |
| outdoors | hobbies | vertical_hobbies_activities | hiking, camping |
| fishing | hobbies | vertical_hobbies_activities | fly fishing, tackle |
| gardening | hobbies | vertical_hobbies_activities | compost, hydroponic |
| three_d_printing | hobbies | vertical_hobbies_activities | slicer, fdm, sla |
| woodworking | hobbies | vertical_hobbies_activities | joinery, saw |
| hobbies_making | hobbies | vertical_hobbies_activities | diy, maker, solder |
| hobbies_collecting | hobbies | vertical_hobbies_activities | stamps, coins |
| board_games | hobbies | vertical_hobbies_activities | dnd, ttrpg |
| recreation | hobbies | vertical_hobbies_activities | golf, tennis, drone |
| photography_hobby | hobbies | vertical_hobbies_activities | camera, lens |
| aquariums | hobbies | vertical_hobbies_activities | fish tank, reef |
| hobbies_general | hobbies | vertical_hobbies_activities | hobby, pastime |
| leatherworking | hobbies | vertical_hobbies_activities | leather craft, tooling |
| cosplay_larp | hobbies | vertical_hobbies_activities | cosplay, prop making |
| **Family & Pets** | | | |
| parenting | family | vertical_parenting_family | baby, toddler, school |
| pregnancy | family | vertical_parenting_family | prenatal, postpartum |
| child_development | family | vertical_parenting_family | milestone, speech therapy |
| family_activities | family | vertical_parenting_family | kids crafts, road trip |
| pets | pets | vertical_pets_animals | dog, cat, vet |
| dog_training | pets | vertical_pets_animals | obedience, clicker |
| equestrian | pets | vertical_pets_animals | horse, dressage |
| birds_exotic | pets | vertical_pets_animals | parrot, aviary |
| aquatic_pets | pets | vertical_pets_animals | aquarium, betta |
| **Automotive** | | | |
| automotive_hobby | automotive | vertical_automotive | car, engine, oil change |
| motorcycles | automotive | vertical_automotive | harley, sportbike |
| ev_vehicles | automotive | vertical_automotive | tesla, charging, hybrid |
| **Home & Living** | | | |
| home_improvement | home | vertical_home_improvement | renovation, plumbing |
| interior_design | home | vertical_home_improvement | decor, furniture |
| home_organization | home | vertical_home_improvement | declutter, storage |
| home_automation | home | vertical_home_improvement | smart home, alexa |
| **Personal Development** | | | |
| career | personal | vertical_personal_development | resume, interview |
| productivity | personal | vertical_personal_development | time management, gtd |
| public_speaking | personal | vertical_personal_development | presentation, speech |
| leadership | personal | vertical_personal_development | management, mentorship |
| **Gaming** | | | |
| gaming | entertainment | vertical_gaming | video game, ps5, xbox |
| game_design | entertainment | vertical_gaming | unity, unreal, godot |
| esports | entertainment | vertical_gaming | twitch, competitive |
| **Sustainability** | | | |
| green_living | sustainability | vertical_sustainability | zero waste, upcycle |
| renewable_energy | sustainability | vertical_sustainability | solar, wind, heat pump |
| **Real Estate** | | | |
| real_estate | real_estate | vertical_real_estate | house, realtor, listing |
| mortgage_finance | real_estate | vertical_real_estate | mortgage, refinance |
| **Relationships** | | | |
| relationships | personal | vertical_relationships | dating, marriage |
| communication_skills | personal | vertical_relationships | conflict resolution |
| **Writing & Publishing** | | | |
| creative_writing | writing | vertical_writing_publishing | fiction, novel writing |
| publishing | writing | vertical_writing_publishing | self-publishing, kdp |
| journalism | writing | vertical_writing_publishing | blogging, copywriting |
| **Events & Planning** | | | |
| events_planning | lifestyle | vertical_events_planning | party, birthday |
| weddings | lifestyle | vertical_events_planning | wedding, registry |
| **Fashion & Style** | | | |
| fashion | lifestyle | vertical_fashion_style | outfit, wardrobe |
| grooming | lifestyle | vertical_fashion_style | beard, haircut |
| **Legal & Finance (Personal)** | | | |
| personal_legal | legal | vertical_personal_legal | will, tenant rights |
| insurance | legal | vertical_personal_legal | health insurance, claim |
| taxes_personal | legal | vertical_personal_legal | tax return, deduction |
| consumer_protection | legal | vertical_personal_legal | identity theft, fraud, phishing |
| **Safety & Emergency** | | | |
| emergency_preparedness | safety | vertical_safety_emergency | disaster, evacuation |
| home_safety | safety | vertical_safety_emergency | fire safety, childproofing |

---

## 2. Canonical Verticals

Vertical = resolved from `active_domain_refs` + `platform_context`. See `vertical_resolver.resolve_active_vertical`.

| Vertical | active_domain_refs (canonical) | platform_context_aliases |
|----------|-------------------------------|--------------------------|
| medical | healthcare_compliance, healthcare, bioinformatics | healthcare, medical |
| fintech | fintech_compliance, fintech | fintech, banking, payments |
| industrial | industrial, aerospace, automotive | industrial, scada, plc |
| platform | kubernetes, openshift, secops_hardening, cloud | openshift, kubernetes, k8s |
| scientific | bioinformatics, geospatial, ml_ops | bioinformatics, genomics, gis, ml |
| lifestyle | athletics_running, nutrition, home_automation, personal_finance | running, athletics, nutrition, smart_home |
| llm_rag | llm_rag | rag, retrieval |
| llm_prompting | llm_prompting | prompting, prompt engineering |
| llm_evaluation | llm_evaluation | eval, evaluation, benchmarking |
| llm_governance | ai_governance | llm safety, ai governance |
| generic | (fallback) | — |

---

## 3. Alias Rules

- **Domain keywords** in plugins: use `domain: <canonical_id>` — e.g. `domain: athletics_running` not `domain: running`.
- **document_domains** in intent_classes: use canonical domain IDs from Section 1.
- **active_domain_refs** in vertical_prompts: use canonical domain IDs; first match wins.
- **RAG catalog**: tag chunks with `domain=<canonical_id>` for filter alignment.

---

## 4. Adding a New Vertical

1. Add `domain_keywords.<category>` with `domain: <new_domain_id>` in a plugin.
2. Add vertical entry in `vertical_prompts.yaml` with `active_domain_refs` and `platform_context_aliases`.
3. Add to `intent_vertical_mapping` in `approach_dark_debt_config.yaml`.
4. Add to `router_to_prompt.by_vertical` in `prompt_taxonomy.yaml` for prompt component bias.
5. If pivot summaries need a domain-specific suffix: add `domain_suffix_by_vertical.<vertical>` in `approach_dark_debt_config.yaml` (pivot_summary_prompts), or add `vertical_to_summary_suffix_key.<vertical>: <existing_key>` to alias to an existing suffix (e.g. astronomy → scientific).

## 5. Seeding Prompt Taxonomy (Router → Prompt Bias)

**File:** `prompt_taxonomy.yaml`

To bias prompts well for a taxonomy/vertical without infinite prompts:

1. **Inheritance:** `default` → `by_intent` → `by_vertical` → `by_task_size`. Later overrides earlier.
2. **Add a new vertical:** Add `by_vertical.<vertical>` with `summary_domain_focus`, `summary_depth`, `evidence_emphasis` as needed. Omit keys to inherit.
3. **Add a new intent:** Add `by_intent.<intent>` similarly.
4. **Domain suffix aliasing:** If vertical X should use the same summary suffix as vertical Y (e.g. astronomy → scientific), add `vertical_to_summary_suffix_key.astronomy: scientific`. No need to duplicate suffix text in approach_dark_debt.
5. **Extending components:** Add new component types to `prompt_components` and reference them in `router_to_prompt`. Wire consumers (e.g. summarizer, executor) to call `get_prompt_components(intent, vertical, task_size)`.

---

## 6. See Also

- [TAXONOMY.md](TAXONOMY.md) — Full design, coverage matrix, plugin catalog
- [vertical_prompts.yaml](../base/planner/vertical_prompts.yaml) — Sovereign persona injection
- [approach_dark_debt_config.yaml](../base/planner/approach_dark_debt_config.yaml) — Approach + carried uncertainties
- [prompt_taxonomy.yaml](../base/planner/prompt_taxonomy.yaml) — Router → prompt components (summary depth, domain focus)
