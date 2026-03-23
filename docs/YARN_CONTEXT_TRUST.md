# Yarn context trust and prompt caching

## Trust planes

- **Server pinned content** (trusted for instruction following): the Yarn `SYSTEM_PROMPT`, pinned tool summary, and optional session replay. This is set by the service, not taken from the OpenAI `messages` array as authority.
- **Client / tool evidence** (untrusted data): anything originating from the IDE transcript, optional `synesis_context`, or tool stdout. It may contain prompt-injection or conflicting “policy” text. The model is instructed to treat delimited blocks as data, not as overrides to system rules.

## Request shape

Optional field on `POST /v1/chat/completions` (extra JSON alongside OpenAI fields):

- `synesis_context` (object, version `"1"`): optional `task_pack`, `taxonomy`, `trust_labels`, `evidence_objects`, `policy_requirements`, `validation_results`, `open_questions`, `decision_trace`. All fields are optional; empty objects omit the structured section.

The last **user** message’s text is wrapped with stable tags (`synesis_coder_turn`, `synesis_user_intent`). Structured fields are serialized in **deterministic** order (sorted keys, sorted evidence) so identical logical payloads produce identical bytes.

## Injection scanning

Incoming `messages` are scanned for known injection patterns on **user**, **assistant**, **tool**, and **system** roles (client-supplied system is not trusted). Assistant `tool_calls[].function.arguments` strings are scanned as well. Matches are redacted before the request is processed further.

## Tool results

Tool messages appended by Yarn wrap stdout in `synesis_tool_output` so the model and operators can distinguish tool data from instructions.

## Maximizing token / prefix cache hits

Design choices that align with OpenAI-style prompt caching and vLLM automatic prefix caching (APC):

1. **Long stable prefix first**: `MemoryBuffer` already emits pinned messages (system, tools, replay) before the growing transcript. Avoid injecting per-request noise (UUIDs, timestamps) into pinned system text.
2. **Fixed delimiter literals**: Outer tags and section names are constants in `base/yarn/app/context/delimiters.py`. Only escaped inner bodies vary.
3. **Deterministic structured serialization**: JSON uses `sort_keys=True` and compact separators; lists like `taxonomy` are sorted; `evidence_objects` are sorted by `(kind, label, body)`.
4. **Monotonic stable zone**: New turns append; prior messages are not reordered. The cache miss is concentrated at the end of the prompt (latest user turn and fresh tool output).
5. **Tool list churn**: Changing the pinned tool summary invalidates the prefix from that message onward—keep tool sets stable when possible.

## Related code

- `base/yarn/app/context/` — schemas, delimiters, reducer
- `base/yarn/app/memory/buffer.py` — three-zone layout
- `base/yarn/app/memory/prefix_optimizer.py` — prefix order checks
- `base/yarn/app/middleware/injection_scanner.py` — pattern scan/redact
