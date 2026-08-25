# Awesome papers and primary references

Curated bibliography for Synesis: security, RAG, evaluation, sensemaking, routing, and agent runtimes. **Implementation details** stay in topic docs ([SECURITY.md](SECURITY.md), [RAG.md](RAG.md), [CRITIC_RESEARCH.md](CRITIC_RESEARCH.md), [SYSTEMS_THEORY.md](SYSTEMS_THEORY.md)); this file is the single place for **canonical links** and one-line “why we care.”

---

## Security and prompt injection

| Title | Link | Why it matters here |
|-------|------|---------------------|
| Spotlighting (delimiting + datamarking) | [arXiv:2403.14720](https://arxiv.org/abs/2403.14720) | TrustPacketV1-style separation of data vs instructions |
| Prompt Fencing | [arXiv:2511.19727](https://arxiv.org/abs/2511.19727) | Structured trust boundaries and verifiable delimiters |
| CaMeL (control/data flow) | [arXiv:2503.18813](https://arxiv.org/abs/2503.18813) | Indirect injection; informs node boundaries and router-only retrieval |
| TrustRAG | [arXiv:2501.00879](https://arxiv.org/abs/2501.00879) | Corpus poisoning; index-time scanning + review |
| SD-RAG | [arXiv:2601.11199](https://arxiv.org/abs/2601.11199) | Sanitization-first retrieval; web path hardening |
| ICON | [arXiv:2602.20708](https://arxiv.org/abs/2602.20708) | Inference-time correction; output guardrails |
| Instruction hierarchy | [arXiv:2404.13208](https://arxiv.org/abs/2404.13208) | Priority of system vs user vs tool; trust tiers |
| OWASP LLM Top 10 | [Project page](https://owasp.org/www-project-top-10-for-large-language-model-applications/) | LLM01 / LLM06 mapping to controls |

---

## RAG and retrieval

| Title | Link | Why it matters here |
|-------|------|---------------------|
| RAG (original) | [arXiv:2005.11401](https://arxiv.org/abs/2005.11401) | Dense retrieval + generation baseline |
| HyDE | [arXiv:2212.10496](https://arxiv.org/abs/2212.10496) | Hypothetical document embeddings |
| IterKey | [arXiv:2505.08450](https://arxiv.org/abs/2505.08450) | Iterative keyword generation for retrieval |
| Cluster-based adaptive retrieval (CAR) | [arXiv:2511.14769](https://arxiv.org/abs/2511.14769) | Similarity-gap / adaptive depth |
| L-RAG | [arXiv:2601.06551](https://arxiv.org/abs/2601.06551) | When to skip or cap retrieval |
| Higress-RAG | [arXiv:2602.23374](https://arxiv.org/abs/2602.23374) | Multi-source RRF-style fusion patterns |
| Reciprocal rank fusion (RRF) | [ACM DL / author version](https://dl.acm.org/doi/10.1145/1540270.1540430) | Rank fusion without score calibration (Cormack, Clarke, Büttcher, SIGIR 2009) |

---

## Critic, judges, and evaluation

| Title | Link | Why it matters here |
|-------|------|---------------------|
| ResearchRubrics | [arXiv:2511.07685](https://arxiv.org/abs/2511.07685) | Deep research rubrics; depth + evidence failure modes |
| RAG-Zeval | [arXiv:2505.22430](https://arxiv.org/abs/2505.22430) | Rule-guided RAG evaluation |
| ARES | [arXiv:2311.09476](https://arxiv.org/abs/2311.09476) | RAG triad; automated evaluation framing |
| GER-Eval (“Learning to Judge…”) | [arXiv:2602.08672](https://arxiv.org/abs/2602.08672) | LLM-designed rubrics; factual settings |
| Latent Judges | [arXiv:2509.24678](https://arxiv.org/abs/2509.24678) | Score compression in LLM-as-judge |
| Causal Judge Evaluation | [arXiv:2512.11150](https://arxiv.org/abs/2512.11150) | Calibration / surrogate metrics |
| CLEAR | [arXiv:2507.18392](https://arxiv.org/abs/2507.18392) | Error analysis via LLM-as-judge |
| ManyIFEval / IFEval line | [arXiv:2311.07911](https://arxiv.org/abs/2311.07911) | Multi-instruction degradation |
| Multi-Dimensional Constraint Framework | [arXiv:2505.07591](https://arxiv.org/abs/2505.07591) | Constraint levels vs compliance |
| WildIFEval | [arXiv:2503.06573](https://arxiv.org/abs/2503.06573) | Constraint classes in the wild |
| BEAVER | [arXiv:2512.05439](https://arxiv.org/abs/2512.05439) | Deterministic verification complements |
| FActScore | [arXiv:2305.14251](https://arxiv.org/abs/2305.14251) | Atomic factual scoring |
| TraceLLM | [arXiv:2602.01253](https://arxiv.org/abs/2602.01253) | Requirements traceability with LLMs |
| AgentAbstain | [arXiv:2607.10059](https://arxiv.org/abs/2607.10059) | Paired should-act/should-abstain evaluation; catches unsafe post-hoc refusal |
| ReliabilityBench | [arXiv:2601.06112](https://arxiv.org/abs/2601.06112) | Repeated-run, perturbation, fault-injection, and metamorphic agent reliability |

---

## Agent memory

| Title | Link | Why it matters here |
|-------|------|---------------------|
| Memora / From Recall to Forgetting | [arXiv:2604.20006](https://arxiv.org/abs/2604.20006) | Invalidated-memory reuse and forgetting-aware memory evaluation |

---

## Sensemaking, cognition, and design theory

| Title | Link | Why it matters here |
|-------|------|---------------------|
| What to Make Sense of in the Era of LLM? | [arXiv:2603.08604](https://arxiv.org/abs/2603.08604) | Human–AI collaborative sensemaking ([DESIGN_THEORY.md](DESIGN_THEORY.md), [SYSTEMS_THEORY.md](SYSTEMS_THEORY.md)) |

*Books and classical articles* (no single URL) are summarized in [SYSTEMS_THEORY.md](SYSTEMS_THEORY.md): Hollnagel (Synesis namesake, Safety-II), Woods & Hollnagel (joint cognitive systems), Klein et al. (data-frame / sensemaking), Pirolli & Card (information foraging), Snowden & Boone (Cynefin), Blei et al. (LDA), Agrawal et al. (diversification), Broder (web search intent), Hearst (search UI / facets).

---

## Routing and taxonomy

| Title | Link | Why it matters here |
|-------|------|---------------------|
| Routesplain | [arXiv:2511.09373](https://arxiv.org/abs/2511.09373) | Concept-based routing for software tasks ([INTENT_TAXONOMY.md](INTENT_TAXONOMY.md)) |

---

## Context, attention, and long prompts

| Title | Link | Why it matters here |
|-------|------|---------------------|
| Lost in the Middle | [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) | U-shaped attention; ordering of context ([context and recall](coder/context-and-recall-architecture.md), [context stretch](coder/YARN_CONTEXT_STRETCH.md)) |

---

## Models and serving (technical reports)

| Title | Link | Why it matters here |
|-------|------|---------------------|
| Qwen3-Coder-Next technical report | [arXiv HTML](https://arxiv.org/html/2603.00729v1) | Tool-call format and parser behavior for coder models |

---

## Agent coding and interfaces (selected non-arXiv)

High-signal **systems and product writeups** that inform coder design goals,
interface contracts, verification loops, and bounded critic behavior:

| Source | Link |
|--------|------|
| SWE-agent (NeurIPS 2024) | [OpenReview](https://openreview.net/forum?id=30hggYAY0Z) |
| Qwen3-Coder blog | [QwenLM](https://qwenlm.github.io/blog/qwen3-coder/) |
| OpenAI Codex long-horizon tasks | [developers.openai.com](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) |
| Codex best practices | [developers.openai.com](https://developers.openai.com/codex/learn/best-practices) |
| Aider lint/test loop | [aider.chat](https://aider.chat/docs/usage/lint-test.html) |
| OpenHands critic pattern | [docs.openhands.dev](https://docs.openhands.dev/sdk/guides/critic) |

---

## Contributing

When you add a **new** arXiv or venue paper to narrative docs, add one row here under the right section and replace long duplicate tables in other files with a pointer to this document.
