# Trial notes

Status: not run. Blank entries are unknown, not zero or success.

## Before starting

- Date and participant:
- Client(s) and exact version(s):
- Model/endpoint, revision when available, thinking/sampling settings:
- Synesis build: see trial.json (keep this checkout and runtime fixed).
- Reviewed source revision and pack digest: see trial.json.
- Source selection and preparation time (minutes):
- Client/MCP setup time (minutes):
- Maximum additional model spend and session time:
- Private source/provider access approved for this workflow:

Use two tasks you already need to complete. Write their prompts, expected evidence
and completion criteria before running either condition. Keep these notes out of
the model's accessible source directory. Do not put private answers in GitHub.

## Task 1

- Real task and why it matters:
- Exact prompt (same in both conditions):
- Expected evidence/answer criteria (for the reviewer):
- Completion check:
- Order: native tools first, then native tools plus Synesis, in fresh sessions.

| Observation | Native tools | Native tools + Synesis |
| --- | --- | --- |
| Completed task? (yes/no, with evidence below) | | |
| Elapsed task minutes | | |
| Missing, incorrect or wrong-version evidence | | |
| User corrections/interventions | | |
| Input/output tokens, if reported | | |
| Additional model cost, if known | | |
| Output/transcript location (private local path) | | |

Evidence supporting the assessment and any setup differences:

## Task 2

- Real task and why it matters:
- Exact prompt (same in both conditions):
- Expected evidence/answer criteria (for the reviewer):
- Completion check:
- Order: native tools plus Synesis first, then native tools, in fresh sessions.

| Observation | Native tools | Native tools + Synesis |
| --- | --- | --- |
| Completed task? (yes/no, with evidence below) | | |
| Elapsed task minutes | | |
| Missing, incorrect or wrong-version evidence | | |
| User corrections/interventions | | |
| Input/output tokens, if reported | | |
| Additional model cost, if known | | |
| Output/transcript location (private local path) | | |

Evidence supporting the assessment and any setup differences:

## Source update and reuse

- Create a new trial/version from an actual source update when one occurs.
- Selection/build/import/update effort (minutes):
- Could the client recover the requested version and cite the right evidence?
- If another client is part of normal work, setup effort and any differences:

## Decision

- What concrete work did Synesis make easier, if any?
- Did the benefit justify selection, setup, update and correction effort?
- Which observed failure warrants a specific change? What simpler option exists?
- Keep using the local tool, make one bounded fix and retry, or use native tools?

Two tasks are a usability trial, not a general model-quality benchmark. Record
mixed or negative results. Do not infer dollar savings from token counts, treat
unknown cost as free, or turn a passing preflight into a completed user task.
