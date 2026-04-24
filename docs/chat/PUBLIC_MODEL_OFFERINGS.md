# Public model offerings

Admin operators can define **public model offerings**: stable client-facing `model` strings (for example `exp-qwen-a`) mapped to **pulse / core / horizon** effort tiers. Offerings can optionally set a **backend model override** (LiteLLM id). Routing (provider URL, API keys) still comes from the active deployment for `coder-*` roles on Yarn and `general-*` roles on the Planner unless you override the model name only.

## Surfaces

- **Admin**: Models & costs → **Model Registry** → *Public model offerings* (platform admin creates rows; org admin can view).
- **Yarn** and **Planner** poll the admin **internal** API on an interval (about **two minutes** in planner-ts; Yarn follows the existing tier refresh loop). Restarting a service or waiting for the next poll picks up changes; there is no need to fork Open WebUI if it already uses `GET /v1/models` on those services.

## Flags

- **Expose to Yarn**: listing and routing in `yarn-ts` (`/v1/models`, chat completions).
- **Expose to Planner**: listing and tier resolution in `planner-ts` (writer uses **resolved_writer_model** when set).

Internal pipeline roles (compaction, normalizer, summarizer, etc.) are not offerable as client ids; reserved names like `pulse`, `core`, `auto` are rejected at create time.

## Traces

- **Yarn**: trace `model` prefers the client request id when provided; `trace_context` includes `client_requested_model`, `resolved_backend_model`, and `registry_tier_id` when applicable.
- **Planner**: traces prefer `requested_model`; `trace_context` can include `registry_general_role`, `resolved_backend_model`, and `client_requested_model` for offerings.

## Requirements

- **Internal service token** must be configured on Yarn and Planner so they can call `GET /api/v1/models/public-offerings/internal?for=yarn|planner` and (Planner) `GET /api/v1/models/roles/internal` for backend model resolution.
