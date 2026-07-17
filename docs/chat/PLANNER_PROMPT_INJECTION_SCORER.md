# Optional second-stage prompt-injection scorer

Planner and Yarn can asynchronously send untrusted user/tool text to a configured HTTP classifier and emit the result through the existing Admin security-event pipeline. No scorer is called unless `SYNESIS_INJECTION_SCORER_URL` is set, and results do not change deterministic block/reduce decisions.

## Goals

- Add semantic detection for novel or obfuscated attacks that deterministic patterns miss.
- Preserve zero default latency and keep model dependencies out of Planner/Yarn images.

## Non-goals

- Replacing regex scanning as the first line of defense (deterministic, fast, auditable).
- Coupling mitigation decisions to a fallible remote classifier.
- Loading `transformers` / `torch` inside Planner or Yarn.

## Selected classifier

The default model identifier is Meta `meta-llama/Llama-Prompt-Guard-2-86M`, a binary benign/malicious prompt-injection and jailbreak classifier. Operators must review and accept the model license before deployment. The scorer URL may target a managed Hugging Face endpoint or an internal compatible service.

The endpoint receives `POST {"inputs":"..."}` and must return a Hugging Face text-classification array containing `BENIGN`/`MALICIOUS` (or `LABEL_0`/`LABEL_1`) scores. Requests are capped at 8,000 characters, responses at 64 KB, redirects are rejected, and timeouts/failures become telemetry events rather than request failures.

## Configuration

The same variables apply to Planner and Yarn:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SYNESIS_INJECTION_SCORER_URL` | empty | Enables asynchronous scoring when set. |
| `SYNESIS_INJECTION_SCORER_TOKEN` | empty | Optional bearer token for the classifier. |
| `SYNESIS_INJECTION_SCORER_MODEL` | `meta-llama/Llama-Prompt-Guard-2-86M` | Model identifier recorded in telemetry. |
| `SYNESIS_INJECTION_SCORER_THRESHOLD` | `0.8` | Score used to label emitted events as semantic injection. |
| `SYNESIS_INJECTION_SCORER_TIMEOUT_MS` | `1000` | Request timeout, constrained to 50-10,000 ms. |

Because raw untrusted text is sent to this endpoint, use a tenant-approved service and transport. Prefer an internal endpoint when prompts may contain confidential data.

## Rollout

1. Enable the endpoint in a non-production environment and inspect `semantic_prompt_injection`, `semantic_prompt_benign`, and `prompt_injection_scorer_failure` events.
2. Tune the threshold against representative tenant traffic without changing deterministic mitigation.
3. Promote only after reviewing data handling, endpoint authentication, model licensing, latency, and false-positive rates.

## References

- [Meta Llama Prompt Guard 2 86M model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
