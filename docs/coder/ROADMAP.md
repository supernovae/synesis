# Synesis Agentic Roadmap

This roadmap outlines future features and capabilities required to compete against industry norms established by tools like Codex, Cursor, Claude Engineer, and Microsoft GitHub Copilot.

## Phase 1: Deep Codebase Intelligence
*   **Code Graph & Semantic AST Search**: Move beyond basic RAG vector search to true semantic code graphs. Agents should be able to query "Find all callers of `foo()` that pass a string argument" using a dedicated graph database or advanced Tree-sitter queries.
*   **Real-time Predictive Edits**: Implement multi-file synchronized edits (cross-file diffs in one shot) similar to Cursor's "Tab autocomplete on steroids", allowing the agent to predict the next logical change across the entire codebase.
*   **Deep Dependency Analysis**: Proactively identify and resolve transitive dependency conflicts, outdated packages, and security vulnerabilities without user prompting.

## Phase 2: Autonomous Execution & Browser Use
*   **Interactive Web Browsing (Computer Use)**: Evolve the `take_screenshot` tool into a fully interactive browser agent (similar to Claude's Computer Use API). The agent should be able to click, type, and navigate web pages to test complex UI flows and authenticate against external services.
*   **Complex Terminal Interception** *(shipped — 2026)*: Bounded terminal handling for workspace MCP (`run_*` / `format_code`), `run_in_sandbox`, and ACP `Bash`: non-interactive env defaults, linear-pass output shaping (ANSI, `\r` redraws, repeated lines), curated classifiers (`terminalSignals` / `terminal_signals`), verification hints in the reducer, and an ACP wall-clock watchdog. See [`docs/coder/TERMINAL_INTERCEPTION.md`](TERMINAL_INTERCEPTION.md).
    *   **Open considerations (not done)**: Idle timeout without streaming stdout (needs a streaming runner or supervisor); richer collapse for spinner frames / tqdm-style progress (first+last line preservation); optional `timeout` wrapper for arbitrary shell beyond fixed presets; explicit integration with `VerificationLoopTracker` metrics for terminal anomalies; ACP client kill/cancel when the bridge times out (documented split responsibility); Docker/BuildKit `--progress=plain` when those tools are allowlisted; optional micro-LLM on a short excerpt remains off by design—revisit only with a hard cap and flag.
*   **Ephemeral Environment Provisioning**: Allow the agent to dynamically spin up and tear down isolated Docker containers or VMs for testing specific architectures (e.g., "Spin up a Postgres DB to test this migration").

## Phase 3: Multi-Agent Orchestration
*   **True Sub-Agents (Planner-Worker-Reviewer)**: Replace the `delegate_task` mock with a robust multi-agent orchestration framework. A "Planner" agent breaks down a task, spawns parallel "Worker" agents for frontend/backend/DB changes, and a "Reviewer" agent synthesizes the final PR.
*   **Agentic Debate & Consensus**: Implement mechanisms for sub-agents to debate architectural decisions and reach consensus before proposing a solution to the user.

## Phase 4: Enterprise & Workflow Integration
*   **Automated PR Generation & Review**: Deep integration with GitHub/GitLab. The agent should autonomously create branches, commit changes, open PRs with detailed summaries, and respond to human reviewer comments in a continuous loop.
*   **Issue Tracker Sync (Jira/Linear)**: Automatically parse tickets, extract acceptance criteria, and link commits/PRs back to the original issue without manual intervention.
*   **Security & Compliance Auto-Remediation**: Integrate with SAST/DAST tools. The agent should proactively scan for secrets, vulnerabilities, and compliance violations, automatically proposing and applying fixes.

## Phase 5: Continuous Learning & Optimization
*   **Reinforcement Learning from Human Feedback (RLHF)**: Implement a feedback loop where user corrections (e.g., rejecting a proposed edit, manually fixing a bug) are captured and used to fine-tune the agent's underlying models or update the Golden Trajectories Cache.
*   **Self-Improving Prompts**: Allow the agent to analyze its own failure rates and autonomously suggest improvements to its system prompts or language pack definitions.
*   **Advanced Multi-modal Debugging**: Enable the agent to analyze screen recordings or video captures of bugs, correlating visual glitches with specific code paths and logs.

### TODO: RLHF Decision Gate

- [ ] Keep RLHF/training behind a metrics gate: apply prompt/policy/tool/MCP improvements first.
- [ ] Require two consecutive eval windows where Git-first and verification KPIs plateau before proposing training.
- [ ] Document residual failure classes that remain after policy tuning (for example repeated unsafe shell attempts, commit hygiene misses, unresolved verification stalls).
- [ ] Only start RLHF data curation after the plateau criterion is met and a canary baseline is captured.