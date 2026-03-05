# Synesis Feedback — Open WebUI Pipe Plugin

View Synesis classifier feedback (thumbs up/down) with classification context inside Open WebUI.

## What it does

- Adds a **Synesis Feedback** "model" to Open WebUI
- When you chat with it, fetches `GET /v1/feedback` from Synesis planner
- Displays message snippets, response snippets, `classification_reasons`, `score_breakdown`, `task_size`
- Filter by vote: "show down" → thumbs down only, "show up" → thumbs up only

## Install

### 1. Import the function

1. In Open WebUI, go to **Workspace → Functions**
2. Click **Import Functions**
3. Upload `synesis_feedback_export.json` (or use "Import from URL" if hosted)

### 2. Configure Valves

1. Open **Admin Settings** (or Workspace → Functions)
2. Find **Synesis Feedback** and click to edit
3. Set **synesis_planner_url** to your planner URL, e.g.:
   - Same cluster: `http://synesis-planner:8000` or `http://synesis-planner.synesis-planner.svc.cluster.local:8000`
   - Local dev: `http://localhost:8000`
4. Optionally set **limit** (default 20)

### 3. Use it

1. Start a new chat
2. Select **Synesis Feedback** as the model (from model dropdown)
3. Send:
   - `show` — all feedback
   - `show down` — thumbs down only (tuning candidates)
   - `show up` — thumbs up only

## Requirements

- **Network** — Open WebUI must reach Synesis planner (same cluster, port-forward, or public URL)
- **httpx** (optional) — Uses stdlib `urllib` if not present; `pip install httpx` for slightly better error handling

## Build export JSON

```bash
cd integrations/openwebui-synesis-feedback
python build_export.py
```

Creates `synesis_feedback_export.json` for import.
