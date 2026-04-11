# OpenAI-compatible API probing

See **[CI_GITHUB_VALIDATION.md](./CI_GITHUB_VALIDATION.md)** for GitHub Variables/Secrets aligned with CI. See also **[TESTING.md](./TESTING.md)** for the broader CI vs manual test matrix.

## Synesis probe (HTTP)

Run against a reachable planner and/or Yarn base URL:

```bash
# Local: probe-specific env names
export SYNESIS_PROBE_PLANNER_URL=https://your-planner:8000   # with or without trailing /v1
export SYNESIS_PROBE_TOKEN='syn-…'                         # optional; enables POST /v1/chat/completions
# optional:
export SYNESIS_PROBE_YARN_URL=https://your-yarn…

# CI: repository variables SYNESIS_PLANNER_EVAL_URL / SYNESIS_YARN_EVAL_URL and secret
# SYNESIS_TEST_PAT_TOKEN (see openai-compat-probe.yml). RAG/knowledge routes use
# SYNESIS_INTERNAL_SERVICE_TOKEN separately — not this probe.

python3 scripts/synesis_openai_capability_probe.py
# strict exit code for automation (still not used as default CI gate):
python3 scripts/synesis_openai_capability_probe.py --strict
```

The probe validates:

- `GET /v1/models`: each entry has OpenAI-documented core fields `id`, `object`, `created`, `owned_by` ([Model object](https://platform.openai.com/docs/api-reference/models/object)).
- `POST /v1/chat/completions` (non-stream): `object`, and `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` when a token is set.

**Streaming `usage`:** OpenAI includes `usage` on the **final** SSE chunk only when the client sends `stream_options: { "include_usage": true }`. Synesis planner matches that behavior.

## Open Harness (upstream)

[Open Harness](https://github.com/jeffrschneider/OpenHarness) conformance tests exercise **Open Harness MAPI** adapters (e.g. Claude Code, Goose), not a generic “point at `/v1/chat/completions`” URL. Cloning that repo and running `pytest tests/conformance` with `SKIP_CONFORMANCE_TESTS=0` measures those adapters — useful for ecosystem awareness, not as a Synesis regression gate.

## Open WebUI

Chat in Open WebUI goes to **planner-ts** by default (`OPENAI_API_BASE_URL` in `base/webui/deployment.yaml`). Model names in the picker come from **planner-ts** `/v1/models`. WebUI feature flags (`ENABLE_IMAGE_GENERATION`, `ENABLE_RAG_WEB_SEARCH`, …) control **Open WebUI’s** features, not Synesis router web search inside the pipeline.
