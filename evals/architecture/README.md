# Architecture evidence

The [decision record](../../docs/ARCHITECTURE_REVIEW.md) selects a local knowledge-first direction. The usable implementation is now the [source-pack CLI and MCP reader](../../docs/SOURCE_PACKS.md). Restoring the former deployment is not required.

## Current executable checks

```bash
npm run build
npm test
node evals/architecture/local-smoke.mjs /tmp/synesis-local-smoke.json
```

The smoke check builds selected repository sources, imports a fresh library, queries it, verifies source reads and removes its temporary files. It starts no model or database service. It is a source-navigation and resource smoke test, not a model-quality or hosted-capacity benchmark.

The production package tests also use the official MCP SDK client over a real subprocess, including different cwd, bounded arguments and shutdown. See the [local core](../../packages/synesis-mcp/).

## Public capability trial

The [trial fixture](pack-trial.json) follows the actual MCP setup change across two repository commits. The [runner](pack-trial.mjs) compares Git archives plus ripgrep, Synesis packs, and the official `@modelcontextprotocol/server-filesystem` **2026.8.31**. Both MCP readers run in two separate SDK sessions with different working directories. Only four explicitly selected public files enter the trial; no private documents or provider endpoints are used.

To reproduce, use Node 24.14+, Git, tar and ripgrep. Install the comparison tool outside the checkout so it does not become a product dependency:

```bash
trial_install=$(mktemp -d /tmp/synesis-trial-install.XXXXXX)
(cd "$trial_install" && npm install --ignore-scripts --omit=dev --save-exact @modelcontextprotocol/server-filesystem@2026.8.31)
npm run build
node evals/architecture/pack-trial.mjs \
  --filesystem-server "$trial_install/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js" \
  --output /tmp/synesis-pack-trial.json
```

Use a fresh output filename for a repeat run. The runner removes its own snapshots, source archives and library. The comparison package remains in the explicit temporary install directory. Dependency installation requires network access unless cached; the trial operations make no network or model calls. Both source commits must be present locally; a shallow checkout may need more history.

### Findings and decision

The [recorded result](pack-trial-result.json) contains five authored public probes, not five completed user tasks. Both readers returned byte-identical evidence for both versions in both SDK sessions. Native search and Synesis search located the expected file in all five probes. Source recovery was given the expected path; this does not demonstrate autonomous evidence selection or improved answers. The private-library question reads public documentation and is not a private-data evaluation.

| Need | What the trial established | Design consequence |
| --- | --- | --- |
| Recover an earlier document version | Git snapshots and Synesis both preserve the selected evidence. | Versioned source storage alone does not justify a separate product. |
| Reuse evidence across working directories | Both MCP servers returned the same snapshot to both SDK sessions. | Cwd independence and offline MCP access are not unique to Synesis. Actual chat/coding clients remain untested here. |
| Keep source identity visible | Synesis returns pack/revision/hash/citation with each read and rejects a missing version. Git identifies revisions through the selected snapshot and commit. | Evaluate whether the combined interface saves real user work; do not claim unique provenance or trust. |
| Find relevant source text | Ripgrep finds matching files; Synesis returns ranked overlapping excerpts. | Different result shapes are not a comparable recall score. Paraphrases and multilingual recall remain open. |
| Limit reader capabilities | Synesis advertises four read tools. The filesystem server also advertises mutation tools; this trial invokes only reads and confirms rejection outside configured directories. | This is a surface-area difference, not a complete comparative security assessment. Client roots and OS permissions need their own policy. |

The two source packs are about the same compressed size as their Git archives and add a local index. Timing observations are single-process development samples. `packFromGitTotalMs` includes Git snapshot preparation, pack construction and import; comparing pack construction alone with a complete Git workflow would hide input-preparation cost. Dependency installation, peak child memory and user setup/correction time were not measured.

**Continue with the local builder/reader only; shared hosting is not justified by this evidence.** For knowledge already in a repository, native Git/files are the first choice to compare. The remaining hypothesis is convenient, bounded reuse of a curated collection across clients, especially when sources are not already organized in one repository. No user trial yet establishes that this convenience earns ongoing maintenance. If native tools satisfy that requirement, archive the reader rather than add a service.

The [filesystem server documentation](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) describes directory arguments, client-provided roots and its file tools. [Context7](https://context7.com/docs/howto/private-sources) already supports private documentation sources, so private knowledge itself is not differentiation either. Context7 was reviewed from documentation, not executed or given access to repository data.

### Next human trial

Choose one recurring project-knowledge task and one actual private-document task already needed by the maintainer. Use the same reviewed source subset first with native/client tools, then with Synesis in the real chat and coding clients. Keep private sources, prompts and outputs outside this repository. Record the task, client/version, source revision, minutes spent selecting/building/updating content, evidence-selection mistakes, user corrections and whether the pack adds a capability the baseline lacks. Record missing observations as unknown; do not fill them with synthetic scores.

Use existing client/model access and an explicit spending limit if model calls are needed. A successful protocol test is not a substitute for this comparison. Add a connector, semantic index or hosted transport only to address a demonstrated gap; delete the unnecessary platform paths once the retained scope is clear.

## Historical evidence

- `inventory.json` records the broad stack at its baseline commit, including configuration counts and route-owner candidates. Dynamic registration still requires inspection before deletion.
- `postgres-smoke.json` records the small PostgreSQL prototype experiment.
- `sqlite-smoke.json` records the initial Python/SQLite feasibility experiment.
- `screening.json` contains twelve screening questions. Private-category questions are repository simulations, and coding questions do not run coding clients. They are not a held-out evaluation suite.

The exploratory HTTP front door, PostgreSQL adapter, alternate archive builder and screening runner have been retired now that the local core exists. Historical measurements remain limited observations, not claims of reproducible current performance or a supported second implementation. Their differing runtimes, tokenizers and concurrency make timing comparisons invalid. No model-quality advantage was measured.

## Retired experiment tooling

The architecture-lab runtime and inventory/paired-analysis CLI have been removed with the platform. The recorded inventory and smoke results above remain historical evidence tied to their baseline revisions. They do not describe the current source tree or imply reproducible timings on this implementation.

The current tools are the source navigation smoke and public capability trial. Actual model runs, private task evidence, human review and a completed held-out suite remain unperformed. Future evaluations should implement only the measurements needed for a concrete product question, rather than restore a general comparison framework.
