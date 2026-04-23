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

### Phase 3 Tracking (Request/Response Runtime)

#### Completed
- [x] Architectural direction locked: deterministic Supervisor source-of-truth, bounded Planner/Worker/Reviewer roles, request/response only (no long-running job orchestration), traces as first-class artifacts.
- [x] Safety constraints locked: no recursive spawning, worker/planner/repair/challenge round limits, conflict escalation, destructive/migration escalation, full-file rewrite deny-by-default.
- [x] Scope lock for MCP surface: dynamic exposure with safe fallback, and no forced external MCP object renames when existing names already exist.

#### Current Iteration (In Progress)
- [x] Replace `delegate_task` mock with production request/response orchestration execution.
- [x] Add shared TypeScript orchestration runtime abstraction (`OrchestrationRuntime` + `RequestResponseRuntime`).
- [x] Add Zod contracts for `ExecutionPlan`, `WorkerTaskPacket`, `WorkerResult`, `DecisionRecord`, and `FinalReview`.
- [x] Implement Cynefin-inspired intake (`clear|complicated|complex|chaotic`) and action routing (`answer_directly|ask_for_clarification|plan_and_execute|offer_paths`).
- [x] Add bounded parallel worker execution (max 5) and reviewer remand policy (max 1 repair pass).
- [x] Implement policy-driven merge/conflict handling with overlap escalation.
- [x] Add compact context + instruction normalization (`AGENTS.md` / `CLAUDE.md` / internal rules) with artifact-ID referencing.
- [x] Add trace model linkage (`trace_id`, `artifact_id`) across planning/execution/review.
- [x] Ship required Phase 3 tests (ambiguity, conflict, architectural fork, remand, rewrite rejection, budgets, normalized instructions, e2e trace).

#### Future Iterations / Remaining Work
- [ ] Durable runtime boundary implementation (long-running async orchestration, resumes/retries across process restarts).
- [ ] Richer architectural challenge UX beyond one challenge + one adjudication while preserving bounded behavior.
- [ ] Expanded typed repo operations (deeper symbol-aware edit primitives and stronger static conflict prediction).
- [ ] Additional governance and eval loops over orchestration traces (quality scoring, regression gates, policy drift alerts).
- [ ] Optional broader MCP surface refinement after baseline stability (further minimization and per-flow policy hardening).

### Shipped: Path Sandbox & Cross-Harness Filesystem Safety (Apr 2026)

Filesystem boundary enforcement for agent file operations. Project root is the sandbox root; cross-project agent configs (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`) are blocked to prevent context poisoning. Includes harness compatibility matrix for 7+ coding harnesses (Claude Code, Cursor, Gemini CLI, Codex CLI, OpenCode, Windsurf, Aider) with `$TMPDIR` carve-out for macOS and `/tmp` nudge toward project-scoped subdirectories. See [`docs/coder/YARN_PATH_SANDBOX.md`](YARN_PATH_SANDBOX.md).

### Shipped: Proportionality Governance (Apr 2026)

Three-layer system to detect when agent changes exceed user intent scope. Prevents agents from deleting features when asked to fix security issues, or rewriting modules when asked for targeted refactors. Classifies user prompts into scope envelopes, tracks cumulative diff stats, and feeds proportionality signals into the sensemaking governor for graduated response (nudge, guide, intervene). Includes optional fast-model critic for high-risk assessments. See [`docs/coder/YARN_PROPORTIONALITY_GOVERNANCE.md`](YARN_PROPORTIONALITY_GOVERNANCE.md).

### Shipped: Deterministic Prefix Cache Optimization (Apr 2026)

Five mechanisms to maximize KV-cache prefix hit rate (targeting 85%+) by transitioning from fluid pruning to deterministic state management. Epoch-based sticky boundary freezes the pruning checkpoint for N turns. Content-hash tool call IDs (`tc_{sha256hex}`) remain byte-identical even when earlier messages shift. Governor guidance is tail-appended instead of mid-spliced. Snap-to-grid aligns message counts to 50-message buckets. Anthropic `cache_control` breakpoints are placed at three deterministic positions: system prefix (BP1), epoch anchor (BP2), and optional volatile-tail midpoint (BP3). See [`base/yarn-ts/docs/CACHING.md`](../../base/yarn-ts/docs/CACHING.md).

### Shipped: Context Stretch Hardening (Apr 2026)

Five improvements to make Yarn's 100k token window resilient to large documents and large repositories. Artifact handles now survive objective scope boundaries, budget compaction writes to the ArtifactStore, `guardedFallbackRead` is capped at 200 KB, plan file paths boost retention during compaction, and the evidence window scales with session length. See [`docs/coder/YARN_CONTEXT_STRETCH.md`](YARN_CONTEXT_STRETCH.md).

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