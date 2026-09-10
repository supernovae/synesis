# Run a real workflow trial

The trial compares your normal client tools with the same tools plus Synesis, using the same selected source bytes. It tests whether the interface helps work you actually need to finish. The setup and preflight make no model calls; actual client sessions may use paid or hosted inference.

Use Node.js 24.14+ on a POSIX system. Install dependencies and build from the checkout:

```bash
npm ci --ignore-scripts --workspace=@synesis/mcp --include-workspace-root=false
npm run build
```

## Check setup with public documentation

This warm-up verifies the kit using five current Synesis documentation files:

```bash
trial_parent=$(mktemp -d /tmp/synesis-trial.XXXXXX)
node scripts/trial.mjs prepare trials/synesis-docs.json \
  --root . --output "$trial_parent/warmup"
node scripts/trial.mjs verify --trial "$trial_parent/warmup"
```

Expect `preflight-passed`. The helper builds a pack and library, checks matching native source bytes, negotiates MCP from a different cwd, and exercises all four tools. It checks a bounded sample read and search response; it is not a retrieval-quality score or a completed user trial. The tests also cover changed/additional evidence and substituted MCP commands.

The output directory contains:

| Path | Purpose |
| --- | --- |
| `native-sources/` | Exact selected source bytes for normal file/search tools. |
| `sources.synpack` | The same evidence as a versioned archive. |
| `library/` | A private library containing that pack only. |
| `mcp.json` | Absolute executable/arguments for the Synesis condition. |
| `trial.json` | Source identity, runtime and implementation fingerprint. |
| `notes.md` | A blank worksheet for tasks, observations and the decision. |

Output must name a new absolute directory whose parent exists. Creation refuses to overwrite an existing trial, uses private POSIX permissions and removes its newly created directory on a caught preparation error. Input selection uses the [pack builder's root and size contract](SOURCE_PACKS.md#build-a-pack).

## Select real work and sources

Choose two tasks already on your list. One might answer a recurring project question; another could use private documentation when your client/provider is permitted to receive it. Use a small, useful collection first—roughly 5–20 text files. Include the evidence the tasks actually need.

Write a build configuration using the [source-pack example](SOURCE_PACKS.md#build-a-pack), with explicit paths, an appropriate source revision, attribution and rights statement. Use a persistent private location for the real trial:

```bash
node scripts/trial.mjs prepare /absolute/reviewed-pack.json \
  --root /absolute/selected-source-root \
  --output /absolute/private-trials/task-set-01
```

The parent directory must already exist. For saved web pages, first use [HTML preparation](SOURCE_PACKS.md#prepare-saved-html). Review the derived text and retain the original file separately.

The helper reads only the configured files. It does not classify secrets or decide whether a model provider may receive them. Packs, snapshots and notes belong outside version control. Keep `notes.md`, expected answers and transcripts out of the client's accessible source roots; do not open the entire trial directory as the evidence project.

## Configure the client

Use your installed client's documented MCP stdio settings. The generated `mcp.json` provides a common configuration shape; its executable and arguments are the contract. Copy/adapt those settings in the client, leaving the generated file intact for verification. See [MCP setup](clients/MCP_QUICKSTART.md).

Use the same client version, model endpoint, model settings and ordinary tool permissions in both conditions. Keep this Synesis checkout, build and Node runtime fixed. The kit does not launch a model or change client configuration automatically.

- **Native condition:** use the normal file/search workflow against `native-sources/`, with Synesis disabled.
- **Synesis condition:** keep those normal tools available and enable the trial's four knowledge tools. Select the pack/version in `trial.json`.

Tell both sessions the selected snapshot location and requested version. Use the same task prompt and fresh sessions; do not copy an answer from the first condition into the second. Keep normal project tools and required working files equivalent. The kit does not sandbox the client's other tools or prove which evidence the model used; record any additional sources and material setup differences.

First confirm the actual client can discover the pack and read a known source. This connection check is separate from the helper's SDK preflight. Record the client/version and any integration failure rather than assuming certification.

## Run and record

Fill in `notes.md` before starting: task prompts, expected evidence, completion checks, client/model versions, source-selection/setup time, and a session-time/additional-spend limit.

Run task 1 with native tools first, then Synesis. Reverse that order for task 2 to reduce simple order effects. Review the actual outputs against the criteria you wrote. Record failures, corrections, elapsed time and cost/token information when available. Unknown values stay unknown; subscription access does not establish zero total cost.

Before and after the sessions, run:

```bash
node scripts/trial.mjs verify --trial /absolute/private-trials/task-set-01
```

Verification detects changed/missing/additional native evidence, source identity changes, additional library versions, and a changed runtime/build or generated MCP launch configuration. It does not execute commands supplied in trial metadata. If the snapshot changed, record the run as inconsistent and prepare a fresh trial before comparing outcomes.

When an actual source update occurs, select a new pack version and prepare another trial directory. Measure the update effort and check version selection. If another client is part of your normal work, repeat the connection/evidence check there; broader client support is not assumed.

## Make a decision

Two tasks can expose usability problems, not establish a general model-quality result. Include selection, setup, update and correction work when deciding whether the tool is worthwhile.

Keep using Synesis if its interface saves useful work without losing needed evidence or adding disproportionate intervention. If a specific problem blocks that benefit, make one bounded fix and repeat the affected task. If normal tools already meet the need with less effort, use them. A trial outcome does not by itself justify a new service or connector.
