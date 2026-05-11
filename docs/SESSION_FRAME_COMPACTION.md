# Frame-Aware Session Compaction

Replaces the lossy truncation summarizer in `planner-ts` with a structured, machine-readable checkpoint that preserves conversational context across long sessions.

## What problem this solves

Before:
- Session history was compacted by truncating the last 20 messages to 240 characters each
- This was lossy: user preferences, topic threads, and conversation mode were discarded
- Long tutoring/debugging sessions degraded over time as early context vanished
- The LLM received a flat list of truncated strings — no structure to reason over

After:
- Compaction produces a structured checkpoint containing domain profile, topic threads, user facts, and conversation arc
- The LLM receives a machine-readable `<SESSION_STATE>` block that preserves durable context without restating recent answers by default
- Zero LLM cost: the compaction is entirely deterministic, using the domain profiler already in the codebase

## What was implemented

### Core compaction logic

- `base/planner-ts/src/context/session-manager.ts`
  - `buildStructuredCheckpoint(history)` — orchestrates the four extraction passes
  - `extractTopics(history)` — scans history in 4-message windows, detecting dominant domain shifts to produce topic threads with `active`/`resolved` status and turn ranges
  - `extractUserFacts(userMessages)` — pulls declarative statements containing personal context (e.g., "I'm using React", "I prefer functional components") into a deduplicated list (up to 12 facts)
  - `detectConversationArc(allText)` — classifies the session as `tutoring`, `debugging`, `coding`, `exploration`, `analysis`, or `general`
  - `renderCheckpoint(checkpoint, recentHistory)` — produces the `<SESSION_STATE>` block consumed by planner and writer; recent exchanges are opt-in

### Domain profiling (reused, not new)

- `base/planner-ts/src/nodes/domain-profile.ts`
  - `buildDomainProfile(text)` — weighted domain extraction based on Data-Frame theory (Klein et al. 2007)
  - Returns `DomainProfile` with weighted domains and frame coherence (`focused`/`composite`/`diffuse`)

### Tests

- `base/planner-ts/tests/session-manager.test.ts`
  - Added tests for structured checkpoint content (domains, arc, coherence, recent exchanges)
  - Added tests for user fact/preference extraction surviving compaction

## Checkpoint format

The rendered `<SESSION_STATE>` block contains five sections:

```
<SESSION_STATE>
Conversation arc: tutoring (12 turns)
Active domains: general(55%), web_frontend(30%), ml_ai(15%) [coherence: composite]
Topic threads:
  - general [resolved] (turns 0-3)
  - web_frontend [active] (turns 4-11)
User stated facts/preferences:
  - I'm using React and TypeScript
  - I prefer functional components
Recent exchanges:
  [user]: Help me study vocabulary: write a sentence...
  [assistant]: Sure! Fill in the blank: The ______ was...
  [user]: B) hesitation
  [assistant]: Correct! Hesitation means a pause before action.
</SESSION_STATE>
```

| Section | Source | Purpose |
|---|---|---|
| Conversation arc | Pattern matching on history text | Tells the LLM to maintain mode (quiz, debug, explore) |
| Active domains | `buildDomainProfile` over full history | Weighted domain context so the LLM knows the subject area |
| Topic threads | 4-message window domain shift detection | Structured map of what was discussed and what's still live |
| User facts | Declarative statement extraction from user messages | Preferences and constraints that survive compaction |
| Recent exchanges | Last 6 messages, lightly truncated | Opt-in verbatim context for clients that do not already send chat history |

## Theoretical basis

- **Data-Frame theory** (Klein, Moon & Hoffman 2006): sensemaking as fitting data into frames. The domain profiler builds a weighted frame over the conversation, and frame coherence tells us whether the session maps to a single domain or is cross-cutting.
- **Cynefin framework** (Snowden & Boone 2007): frame coherence maps to domain complexity — `focused` sessions are obvious/complicated, `composite` sessions need multi-expert treatment, and `diffuse` sessions may need probing.

## Design decisions

| Decision | Rationale |
|---|---|
| Deterministic, no LLM call | Zero latency cost, zero token cost; runs synchronously during `recordTurn` |
| Reuse `buildDomainProfile` | Already proven in entry-classifier and sensemaking; single source of truth for domain detection |
| 4-message topic windows | Balances granularity vs. noise; matches typical user-assistant exchange pairs |
| Cap at 12 user facts | Prevents checkpoint bloat in very long sessions while retaining the most recent preferences |
| Recent verbatim exchanges disabled by default | OpenAI-style clients such as OpenWebUI already send chat history; duplicating answers in the checkpoint can make older turns too salient |

## Expansion paths

1. **Async LLM-powered compaction** — use `synesis-summarizer` to produce richer structured checkpoints for sessions exceeding ~30 turns, at the cost of one summarization call
2. **Context drift scoring** — compute a `context_drift_score` from topic thread diversity and suggest starting a new conversation when context is wandering
3. **Cross-session memory** — persist extracted user facts to a longer-lived store (Redis/Postgres) so preferences carry across conversations
