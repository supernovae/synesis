# OpenAI Test Harnesses

This repo now has three harnesses for validating the Yarn OpenAI-compatible
interface without depending on a single client implementation.

## Why these harnesses exist

When debugging client-specific behavior (opencode, Cursor, Claude Code bridge,
etc.), we need a baseline to answer:

- Is Yarn itself working?
- Is the issue specific to one client's transport/session behavior?
- Which headers/metadata/session fields materially change behavior?

These harnesses provide that baseline.

---

## 1) TypeScript conformance harness (contract checks)

Path: `base/yarn-ts/scripts/openai-conformance.ts`

Use this to validate API shape/contract behavior:

- `/v1` and `/v1/models` shape
- `/v1/chat/completions` non-stream + stream protocol
- auth and invalid-payload error envelopes
- tool history payload acceptance/repair behavior

Run:

```bash
cd base/yarn-ts
SYNESIS_YARN_EVAL_URL="https://<yarn-host>" \
SYNESIS_TEST_PAT_TOKEN="<token>" \
SYNESIS_VERIFY_MODEL="synesis-core" \
npm run verify:openai-conformance
```

---

## 2) Python session harness (single-profile deep check)

Path: `scripts/synesis_openai_session_harness.py`

Use this to validate one cohesive session end-to-end:

- multi-turn continuity
- streaming completion latency
- minimal tool call emission
- explicit client/conversation/metadata shim behavior

Install dependency:

```bash
pip install openai
```

Run:

```bash
python3 scripts/synesis_openai_session_harness.py \
  --base-url "https://<yarn-host>" \
  --token "<token>" \
  --model "synesis-core" \
  --client "opencode-harness"
```

Useful flags:

- `--conversation-id` force a known session id
- `--user` override OpenAI `user` field attribution
- `--cwd` set `synesis_project_root` / `synesis_shell_cwd` metadata

---

## 3) Python comparison harness (profile matrix)

Path: `scripts/synesis_openai_comparison_harness.py`

Use this to compare profile behavior side-by-side:

- `raw_opencode_like` (minimal body, no synesis hints)
- `shimmed_opencode` (client+conversation+metadata shims)
- `explicit_cohesive` (fully explicit cohesive profile)

For each profile it reports:

- non-stream turn outputs
- continuity hint on turn 2
- stream elapsed seconds
- tool-call emission status

Run:

```bash
python3 scripts/synesis_openai_comparison_harness.py \
  --base-url "https://<yarn-host>" \
  --token "<token>" \
  --model "synesis-core" \
  --output-json /tmp/openai-comparison.json
```

---

## Recommended debugging workflow

1. Run `openai-conformance.ts` first (contract baseline).
2. Run `synesis_openai_session_harness.py` (single-session behavior).
3. Run `synesis_openai_comparison_harness.py` (profile delta analysis).
4. Then test in opencode and compare logs against harness results.

If harnesses pass but opencode fails, the issue is likely client transport,
session replay, or timeout policy rather than core API contract behavior.
