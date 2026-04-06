# CLAUDE.md

Work narrowly and cheaply.

- Do not scan the full repo unless required.
- Search first, then open only relevant files.
- Fix one package or one failing target at a time.
- Make minimal edits.
- Prefer patches over rewrites.
- Run gofmt on changed Go files.
- Run the narrowest relevant go test command first.
- Summarize logs; do not keep large outputs in context.
- Avoid unrelated refactors or dependency changes.
- After each step, report:
  - target
  - root cause
  - files changed
  - validation result
  - next smallest step
