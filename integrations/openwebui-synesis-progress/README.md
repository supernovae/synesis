# Synesis Progress Pipe (Open WebUI)

This Open WebUI Pipe proxies Synesis planner streaming responses and mirrors planner phase/status updates into the chat transcript (GPT-like "what it's doing" feedback).

It is intended for users who want richer perceived progress during long planning/research phases.

## Files

- `pipe.py` — Pipe implementation
- `build_export.py` — Generates Open WebUI import JSON
- `synesis_progress_export.json` — Ready-to-import function export

## Requirements

- Open WebUI `v0.8.10` or newer
- Planner reachable from Open WebUI

## Import

1. Open WebUI → **Workspace** → **Functions**
2. Click **Import Functions**
3. Upload `synesis_progress_export.json`
4. Select model **Synesis Progress Pipe** in a new chat

## Valves

- `planner_url` — default internal planner service URL
- `planner_model` — defaults to `synesis-agent`
- `request_timeout_seconds` — defaults to `600`
- `mirror_status_to_chat` — when `true`, writes phase updates into chat (blockquote lines)
- `status_prefix` — text prefix for mirrored status lines

## Behavior

- Reads planner SSE status events (`event.type == "status"`)
- Forwards content deltas as they arrive
- Mirrors progress status to:
  - Open WebUI status channel (`type: status`)
  - Chat transcript (`type: message`) when `mirror_status_to_chat=true`

## Notes

- This does not modify planner reasoning or answer quality.
- For instant rollback, switch back to `synesis-agent` model or disable `mirror_status_to_chat`.
