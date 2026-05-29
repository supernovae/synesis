# Public model offerings

Admin operators can define **public model offerings**: stable client-facing `model` strings (for example `qwen3.6-pro`) that appear in `/v1/models` and can be selected by Open WebUI, CLI clients, and Coder Harness.

Offerings do not replace canonical role names (`coder-pulse`, `coder-core`, `coder-horizon`, `writer-*`). They are additional selectable model names.

## Connection modes

Each offering has one of two routing modes:

1. **`role_clone`** (default)
   - Reuses URL + API key routing from a canonical coder role (`route_via_role`).
   - Optional `backend_model_override` can change only the wire model id.
2. **`standalone`**
   - Uses offering-level Yarn connection fields:
     - `standalone_provider`
     - `standalone_endpoint`
     - `standalone_api_key_env`
   - Still carries an `effort_tier` profile (`pulse` / `core` / `horizon`) for behavior mapping.
   - Planner resolves the offering route directly from the admin registry; planner model id resolves from `backend_model_override` or `client_model_id`.

## Surfaces

- **Admin**: Models & costs → **Model Registry**.
  - Canonical mapping table: role assignments.
  - New Model modal: create offerings, exposure flags, connection mode.
- **Yarn** and **Planner** poll the admin internal API for offerings.
  - Planner poll cadence is about 2 minutes.
  - Yarn follows tier refresh cadence.

## Exposure flags

- **Expose to Yarn**: list + route in `yarn-ts` (`/v1/models`, chat completions).
- **Expose to Planner**: list + tier behavior in `planner-ts`.

Reserved names like `pulse`, `core`, `horizon`, `auto`, internal role ids, and other internal model ids remain blocked.

## Traces

- **Yarn**: trace `model` prefers client-requested id; `trace_context` includes `client_requested_model`, `resolved_backend_model`, and `registry_tier_id`.
- **Planner**: traces prefer `requested_model`; `trace_context` can include `registry_writer_role`, `resolved_backend_model`, `client_requested_model`, and `architecture_mediation` with the selected mediation mode, architecture profile, chat profile, hygiene score, active-state hash, fact-pin count, evidence-manifest count, and verification warnings.

## Planner architecture mediation

Planner resolves architecture-aware mediation against the writer model selected
by the offering or role route. This means a stable public offering name can map
to a DeepSeek, Qwen, Kimi/Moonshot, MiniMax, or full-attention backend while the
Planner prompt harness adapts context handling for that backend.

Set **Model capability preset** on an offering when the public model id is
opaque or provider-neutral, for example a Crof-hosted `v4-pro` endpoint that
should use the `deepseek_v4` harness preset. Presets are controlled values, not
freeform labels, and are evaluated per registered model/offering so a single
endpoint can expose different classes safely.

Operators can tune behavior at three levels:

- request controls: `x-synesis-context-mediation` or
  `metadata.synesis.contextMediation`;
- model/offering controls: `model_capability_preset` for controlled
  class/version defaults;
- Prompt Library `model_family` overlays for broad family behavior;
- Prompt Library `chat_profile` overlays for Open WebUI scenarios such as
  `roleplay_creative_continuity`, `tutoring_study`, and `rag_grounded_answer`.

See [Planner Architecture Mediation](PLANNER_ARCHITECTURE_MEDIATION.md) for
the mode contract and model-family defaults.

## Requirements

- Yarn and Planner require internal service auth to call:
  - `GET /api/v1/models/public-offerings/internal?for=yarn|planner`
  - Planner also calls `GET /api/v1/models/roles/internal` for fallback role model lookups.
- For standalone Yarn offerings, `standalone_api_key_env` must exist in the Yarn runtime environment.
