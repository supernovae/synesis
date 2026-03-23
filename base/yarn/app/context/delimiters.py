"""Fixed delimiter strings for Yarn trust envelopes.

These literals are intentionally stable across requests and turns so that
prefix-based prompt caching (OpenAI prompt cache, vLLM APC, etc.) sees a
maximal byte-identical prefix: only escaped inner bodies and ordering of
optional structured sections may change.

Do not embed timestamps, request IDs, or random salts in these strings.
"""

from __future__ import annotations

# Turn bundle (one user message to the model API)
SYNESIS_CODER_TURN_OPEN = '<synesis_coder_turn v="1">'
SYNESIS_CODER_TURN_CLOSE = "</synesis_coder_turn>"

# Primary natural-language intent from the client (scanned for injections)
SYNESIS_USER_INTENT_OPEN = '<synesis_user_intent trust="client_untrusted">'
SYNESIS_USER_INTENT_CLOSE = "</synesis_user_intent>"

# Optional JSON-like structured fields (sorted keys in JSON; deterministic block order)
SYNESIS_STRUCTURED_OPEN = '<synesis_structured_context trust="client_hints" tier="low">'
SYNESIS_STRUCTURED_CLOSE = "</synesis_structured_context>"

# Individual evidence rows (opening tag is built in reducer with escaped attributes)
SYNESIS_EVIDENCE_CLOSE = "</synesis_evidence>"

# Tool results appended by the server (name varies; tag name is stable prefix)
SYNESIS_TOOL_OUTPUT_OPEN = '<synesis_tool_output name="{name}" trust="untrusted">'
SYNESIS_TOOL_OUTPUT_CLOSE = "</synesis_tool_output>"
