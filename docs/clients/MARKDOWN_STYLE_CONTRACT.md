# Markdown Style Contract

Synesis Yarn supports a response-style layer that improves markdown quality and consistency across clients.

## Objectives

- Produce readable, scannable answers with clear section structure.
- Improve copy/paste usability for commands and code snippets.
- Keep style deterministic without changing core assistant semantics.

## Config

- `SYNESIS_YARN_RESPONSE_STYLE_MODE`
  - `off`: disabled
  - `guidance`: inject style instructions only
  - `guardrail`: guidance plus lightweight final-text markdown cleanup
- `SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID`
  - `true`: encourage mermaid when architecture/flows benefit
  - `false`: discourage mermaid unless explicitly requested

## Prompt-level behavior

When enabled, Yarn injects a tagged system block:

```text
<RESPONSE_STYLE>
...
</RESPONSE_STYLE>
```

This block is placed with other high-priority system context and participates in attention positioning.

## Optional admin override

Operators can override default style instructions via prompt profiles using:

- `target_type = "node"`
- `target_value = "response_style"`

If present, that node profile replaces the built-in style body.

## Guardrail mode behavior

`guardrail` mode performs small formatting-only fixes on final assistant text:

- normalize heading spacing
- ensure unclosed fenced code blocks are closed
- normalize bullet marker spacing

It does not intentionally rewrite semantics or alter tool-call logic.

