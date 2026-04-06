# Advanced Agentic Capabilities (Completed)

This document outlines the advanced agentic capabilities recently implemented in the Synesis `yarn-ts` agent runtime, bringing it closer to parity with state-of-the-art coding agents (e.g., Cursor, Devin, Claude Engineer).

## 1. Context Management & Token Efficiency

*   **AST-Based Code Outlines (Skeletonization)**: Implemented via the new `ast-mcp` Python server. The agent can now use `get_file_outline` to retrieve class names, function signatures, and docstrings without reading entire files, massively reducing token bloat during the discovery phase.
*   **Aggressive Context Eviction**: The `WorkingFrameService` now dynamically evicts stale files from the context window when transitioning out of the `explore` phase, keeping the LLM focused on the active implementation.
*   **Prefix Caching Bias for Rule Files**: Core rule files (`.cursorrules`, `.claude.md`, `AGENTS.md`) are explicitly preserved in the active files list regardless of phase eviction, ensuring they stay in the context window and benefit from LLM prefix caching.
*   **Diff-Based Editing (`str_replace`)**: Replaced full-file rewrites with a deterministic `str_replace` tool. The agent now outputs only the exact lines being changed, reducing token usage and minimizing the risk of truncation or syntax errors.

## 2. 0-Shot Completeness & Feedback Loops

*   **Speculative Execution (Sandbox Loop)**: Integrated the `run_in_sandbox` tool, allowing the agent to execute code in the isolated `synesis-warm-pool` sandbox. The agent can capture `stderr`/`stdout` and self-correct before finalizing a task.
*   **Web Fetching & Documentation Retrieval**: Added the `search_developer_docs` tool to the MCP catalog. The agent can now query the RAG knowledge base for up-to-date developer documentation, reducing hallucinations for newer libraries.
*   **Visual / Multimodal Context (UI Verification)**: Deployed a dedicated `vision-worker` (Playwright-based) and added the `take_screenshot` tool. The agent can now capture headless browser screenshots of URLs to visually verify UI changes.

## 3. Dynamic Phase-Specific Prompts

The system now dynamically injects phase-specific directives into the `<WORKING_FRAME>` based on the current execution phase:
*   **Discovery/Research**: Explicitly forbids proposing edits and forces the use of search tools to build a mental map.
*   **Debugging/Triage**: Forces the agent to explicitly state hypotheses for a verification failure before reading more files.
*   **Self-Review**: Injected into the `preFinalizeCritic`, forcing the agent to review its own diff against the original user request before finalizing.

## 4. Determinism & Re-use

*   **Experience Library (Golden Trajectories Cache)**: Added placeholder logic to inject `<PREVIOUS_SUCCESS>` blocks when a user intent matches a known successful pattern, paving the way for few-shot learning from past successes.
*   **Enhanced Deterministic Offloading (Auto-Fixers)**: Extended the language pack `FixRecipe` interface with an `autoFixer` property, allowing trivial errors (e.g., missing imports) to be fixed deterministically without LLM overhead.
*   **Multi-Agent Delegation**: Implemented a mock `delegate_task` tool, laying the groundwork for spawning parallel sub-agents for complex architectural tasks.