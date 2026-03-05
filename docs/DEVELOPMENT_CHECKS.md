# Development Checks — Local Validation Against Deployed Release

Run these after push + deploy to validate intent flow and prompting against the release you want to regression-test.

---

## Quick Reference (Makefile)

From project root:

| Target | Description |
|--------|-------------|
| `make mock-tests` | Offline tests: routing, API, E2E with mocked LLMs. No network. |
| `make online-tests` | Hit live planner via `oc port-forward`. Requires tunnel running. |
| `make tests` | Alias for `mock-tests` |

Prerequisites for mock-tests: `cd base/planner && pip install -r requirements.txt -r requirements-test.txt`

---

## Prerequisites

- OpenShift cluster with Synesis deployed
- `oc` logged in
- Release deployed (the version you intend to validate)

---

## 1. Unit Tests (No Model, No Network)

EntryClassifier and routing logic are deterministic. Run anytime without deployment:

```bash
make mock-tests
# Or manually:
cd base/planner
pip install -r requirements.txt -r requirements-test.txt
pytest tests/test_intent_validation.py tests/test_graph_routing.py tests/test_routing_parity.py tests/test_e2e_graph.py tests/test_api.py -v
```

These assert on `task_size`, `interaction_mode`, routing (trivial → context_curator, etc.). See `base/planner/tests/validation_prompts.yaml`.

---

## 2. Live Integration Validation (Against Deployed Planner)

Validates **end-to-end** behavior: trivial path returns code, educational mode returns Learner's Corner, UI helper short-circuits.

### Step 1: Deploy Your Release

```bash
# Build, push, deploy (or use your normal deploy flow)
./scripts/build-images.sh --only planner
# Push to registry, then:
kubectl rollout restart deployment/synesis-planner -n synesis-planner
kubectl rollout status deployment/synesis-planner -n synesis-planner
```

### Step 2: Tunnel to Planner

In one terminal, run:

```bash
oc port-forward svc/synesis-planner 8000:8000 -n synesis-planner
```

Leave this running. The planner API is now at `http://localhost:8000`.

**Alternative (Route):** If your cluster exposes the planner via a Route (e.g. `synesis-planner.apps.your-cluster.example.com`), you can use that URL instead:

```bash
python scripts/validate-intent-live.py --url https://synesis-planner.apps.your-cluster.example.com
```

### Step 3: Run Validation

In another terminal:

```bash
# From repo root
python scripts/validate-intent-live.py
# or with explicit URL
python scripts/validate-intent-live.py --url http://localhost:8000
# verbose (print response preview on failure)
python scripts/validate-intent-live.py -v
```

**Requirements:** `pip install httpx pyyaml` for full prompt set. Without them: uses stdlib urllib and inline fallback (2 prompts).

### Expected Output

```
Validating against http://localhost:8000/v1/chat/completions (5 prompts)...

  ✓ [1] "hello world in python"
  ✓ [2] "print hello"
  ✓ [3] "explain how a simple hello world works in Python"
  ✓ [4] "suggest 3-5 follow-up questions"
  ✓ [5] "write a one-line Python script that prints the current date"

All checks passed.
```

---

## 3. When to Run

| Check | When | Why |
|-------|------|-----|
| Unit tests | Before/after code changes | Fast feedback on EntryClassifier, routing |
| Live validation | After push + deploy | Confirms deployed release behaves as expected |

**Workflow:** Push → Deploy → `oc port-forward` → `validate-intent-live.py`. Use as a pre-release or post-deploy smoke test.

---

## 4. Customizing Prompts

- **Unit tests:** Edit `base/planner/tests/validation_prompts.yaml` (EntryClassifier expectations).
- **Live validation:** Edit `base/planner/tests/integration_prompts.yaml` (response-shape assertions).

Both files are the source of truth for regression coverage.
