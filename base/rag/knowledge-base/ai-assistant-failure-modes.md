# AI Assistant Failure Modes — Detection and Mitigation Catalog

## Overview

Production AI assistants fail in predictable ways. This catalog documents concrete failure patterns, how to detect them at runtime, and specific mitigations. Use this as a reference when designing escalation, confidence calibration, and monitoring systems.

## Failure Mode 1: Confident Hallucination

**Pattern**: The model generates plausible-sounding but factually incorrect information with no hedging language. Common in domain-specific queries where training data contains similar but non-identical facts.

**Detection mechanisms**:
- **Retrieval overlap scoring**: Compare generated claims against RAG-retrieved passages. If a factual claim has no supporting passage within cosine similarity >0.7, flag it. Tools: custom post-generation validator, or critic node with explicit "check claims against context" instruction.
- **Self-consistency check**: Generate the same response 3x at temperature 0.5-0.7. If key facts differ across generations, confidence is low. Cost: 3x inference, use only for high-stakes queries.
- **Lexical uncertainty signals**: Absence of hedging phrases ("I believe", "based on available information", "this may vary") in responses about domain-specific topics is a red flag, not a green one.

**Mitigations**:
- Inject `[Assumption]` and `[Uncertain]` tagging instructions into the system prompt.
- Use the critic node to check for unsupported claims: "Does the response contain specific claims not grounded in the provided context?"
- For high-stakes domains (security, compliance), require RAG grounding — refuse to answer if retrieval returns no relevant passages above threshold.

## Failure Mode 2: Shallow Summarization of Complex Topics

**Pattern**: The model produces a structurally correct but substantively thin response, listing topics without analysis. Common when prompts request multi-section deliverables and the model "spreads thin" across all sections.

**Detection mechanisms**:
- **Token density per section**: If the response has N sections and total tokens T, average tokens per section is T/N. If T/N < 150, the response is likely shallow. Measurable post-generation.
- **Specificity heuristics**: Count named technologies, version numbers, quantified claims (latency, cost, team size). Fewer than 2 per section in a technical response indicates shallow output.
- **Critic evaluation**: "Does each section contain at least one concrete recommendation with justification?" Score 0-1 per section.

**Mitigations**:
- Use planner decomposition to create explicit per-section deliverables with minimum depth requirements.
- Set pinned context to "detailed analysis" mode (not "formatted text") for planned knowledge tasks.
- Increase token budget floor for complex tasks (4096+ tokens for multi-section responses).
- Consider multi-pass generation: generate each section independently with focused context.

## Failure Mode 3: Generic Architecture Template

**Pattern**: The model produces an architecture diagram that reads like a textbook — microservices, API gateway, message queue, cache — without tailoring to stated constraints (team size, timeline, budget, specific tech stack).

**Detection mechanisms**:
- **Constraint echo check**: Extract user's stated constraints and verify each appears in the response. If "budget is limited" appears in the prompt but the response proposes 4 separate managed services, the model ignored the constraint.
- **Specificity ratio**: Count generic terms ("scalable", "robust", "efficient") vs. specific terms ("L40S", "Milvus", "3-month timeline"). Ratio >2:1 generic-to-specific indicates template output.

**Mitigations**:
- Inject constraints into the planner's assumption list so they propagate to every section.
- Add "CONSTRAINT ADHERENCE" rules to the worker prompt that explicitly forbid proposing stacks that violate stated constraints.
- Ground with curated ADR examples that demonstrate the pattern of constraint-driven decision-making.
- Use the critic to evaluate: "Does the architecture respect the stated team size and timeline? Name specific violations."

## Failure Mode 4: Refusal Cascade

**Pattern**: The model refuses to answer when it should attempt an answer with appropriate caveats. Common with safety-tuned models that interpret ambiguous prompts as potentially harmful, or when retrieval returns no results and the model defaults to "I cannot help with that."

**Detection mechanisms**:
- **Refusal phrase detection**: "I cannot", "I'm not able to", "I don't have access to", "As an AI" — track frequency. If refusal rate exceeds 5% of non-harmful queries, the threshold is too aggressive.
- **Empty response detection**: Response length < 50 tokens for a non-trivial query indicates premature refusal or generation failure.

**Mitigations**:
- Distinguish "lack of evidence" from "harmful request" in the routing logic. Lack of evidence should trigger a caveat-laden response, not a refusal.
- Implement graduated confidence: high confidence (answer directly), medium confidence (answer with caveats and sources), low confidence (answer with explicit uncertainty markers and suggest verification), no evidence (ask clarifying question or suggest where to look).
- Set the system prompt to prefer "I'm not certain, but here's what I know" over "I cannot help with that."

## Failure Mode 5: Context Window Overflow

**Pattern**: Long conversations or large RAG contexts push the model past its effective context window. The model loses track of early instructions, constraints, or conversation context. Output quality degrades silently.

**Detection mechanisms**:
- **Token count tracking**: Monitor total prompt + context tokens per request. Quality degrades noticeably above 70-80% of the model's context window (e.g., >6K tokens for 8K context, >25K for 32K).
- **Instruction compliance drop**: If the model stops following structural rules (e.g., stops using `[Assumption]` tags, ignores constraint sections), context overflow is likely.

**Mitigations**:
- Implement context budget management: cap RAG context at 30% of total context window, conversation history at 20%, system prompt at 10%, leaving 40% for generation.
- Use context compression for long conversations: summarize older turns rather than passing full history.
- Monitor and alert when average prompt length exceeds 60% of model context window.

## Failure Mode 6: Inconsistent Multi-Turn Behavior

**Pattern**: The model contradicts its own previous responses, changes technology recommendations mid-conversation, or loses track of decisions made in earlier turns.

**Detection mechanisms**:
- **Decision tracking**: Maintain a structured list of decisions made in conversation. On each response, check for contradictions against prior decisions.
- **User feedback signals**: Users saying "but you just said..." or "that contradicts what you recommended" are direct signals.

**Mitigations**:
- Pass a "decisions so far" summary in the system prompt for multi-turn conversations.
- Use the planner node to maintain a session-level decision log.
- Implement explicit "decision commit" markers: once the model recommends X, it should not recommend Y without acknowledging the change and explaining why.
