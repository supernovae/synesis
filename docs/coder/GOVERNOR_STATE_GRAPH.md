# Governor State Graph

Visual map of how the Yarn execution governor behaves across phases, loop detection, recovery rewrites, and hard-stop escalation.

Primary implementation references:

- `base/yarn-ts/src/governance/execution-governor.ts`
- `base/yarn-ts/src/index.ts`

Static SVG render (for viewers that do not render Mermaid):

![Governor State Graph](./GOVERNOR_STATE_GRAPH.svg)

---

## 1) Phase State Machine

```mermaid
stateDiagram-v2
    [*] --> Explore: investigation intent + no edits
    [*] --> Edit: default start

    Explore --> Explore: repeated discovery/read loops
    Explore --> Edit: first successful edit

    Edit --> Edit: edit retries / write cycles
    Edit --> Verify: verification command (test/build/lint)
    Edit --> Report: completion claim tail (non-edit)

    Verify --> Verify: repeated verification commands
    Verify --> Edit: make another edit
    Verify --> Finalize: completion claim + green verification

    Report --> Edit: new fix needed
    Report --> Finalize: task update / commit / done path

    Finalize --> Edit: new user requirement or follow-up change
```

---

## 2) Per-Turn Governor Decision Pipeline

```mermaid
flowchart TD
    A[Request arrives] --> B[Transcript normalization<br/>read snapshots + dedup + annotations]
    B --> C[Turn scoping from latest user prompt]
    C --> D[Extract command events]
    D --> E[Infer session phase<br/>explore/edit/verify/report/finalize]
    E --> F[Evaluate rules with phase allowlist]

    F -->|no matched rules| G[Allow response]
    F -->|matched rules + pause| H[Recovery path]

    H --> I{Concrete progress this turn?}
    I -->|yes| J[Decrement recovery streak]
    I -->|hold condition| K[Hold streak increment]
    I -->|no| L[Increment recovery streak]

    J --> M{Terminal rule + threshold hit?}
    K --> M
    L --> M

    M -->|no| N[Inject recovery system block<br/>apply tool restrictions]
    M -->|yes| O{Edit-replay only + grace unused?}
    O -->|yes| P[Grant one grace attempt]
    O -->|no| Q[Emit governor pause envelope<br/>soft fail hard-stop]

    P --> N
    N --> R[Model continues with constrained tools]
    G --> R
```

---

## 3) Expected Healthy Failure-Repair Loop

This is the target behavior when tests fail.

```mermaid
flowchart LR
    T1[Run targeted test/build] --> T2[Test fails with concrete signal]
    T2 --> T3[Read relevant file/context once]
    T3 --> T4[Make one focused edit]
    T4 --> T5[Run one narrow verification]
    T5 --> T6{Pass?}
    T6 -->|no| T3
    T6 -->|yes| T7[Report / finalize]
```

If the model keeps rerunning verification with no edit, governor rules like:

- `verification_fail_repeat_block`
- `verification_same_failure_signature_replay`
- `verification_churn_no_edit`

should push it back to **T4 (focused edit)**, not endless test loops.

---

## 4) Escalation Semantics (Current)

- Recovery streak is tracked per session and adjusted by progress signals.
- Hard-stop threshold is `7`.
- One-time grace exists for pure edit-replay terminal cases before final pause.
- Hard-stop emits a structured pause envelope (`synesis_governor_pause`) plus human guidance.

---

## 5) Where to Tune Behavior

- Rule matching + phase gating: `base/yarn-ts/src/governance/execution-governor.ts`
- Recovery streak, hard-stop grace, terminal filtering, tool restriction wiring: `base/yarn-ts/src/index.ts`
- Latest-tool progress classification: `base/yarn-ts/src/governance/recovery-progress.ts`
