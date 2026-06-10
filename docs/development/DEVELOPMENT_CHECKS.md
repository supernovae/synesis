# Development Checks — Local Validation Against Deployed Release

Run these after push + deploy to validate intent flow and prompting against the release you want to regression-test.

**CI inventory:** see [TESTING.md](./TESTING.md) for what runs on every PR vs manual-only. For current engineering indexes, see [development README](./README.md).

---

## Quick Reference (Makefile)

From project root:

| Target | Description |
|--------|-------------|
| `make mock-tests` | Offline tests: routing, API, E2E with mocked LLMs. No network. |
| `make online-tests` | Hit live planner via `oc port-forward`. Requires tunnel running. |
| `make tests` | Alias for `mock-tests` |

Prerequisites for mock-tests: repo-root `npm ci` (see `Makefile` and `lint.yml` — matches planner-ts CI).

---

## Prerequisites

- Kubernetes cluster with Synesis deployed (OpenShift supported)
- `kubectl` logged in (`oc` also works on OpenShift)
- Release deployed (the version you intend to validate)

---

## 1. Unit Tests (No Model, No Network)

Planner-ts unit tests are deterministic. Run anytime without deployment:

```bash
make mock-tests
# Or manually:
npm ci && npm test -w synesis-planner-ts
```

Routing and graph behavior are covered by Vitest under `base/planner-ts/tests/`. Prompt fixtures for live checks live under `tests/prompts/`.

---

## 2. Live Integration Validation (Against Deployed Planner)

Validates **end-to-end** behavior: trivial path returns code, educational mode returns explain-only content, UI helper short-circuits.

### Step 1: Deploy Your Release

```bash
# Build, push, deploy (or use your normal deploy flow)
./scripts/build-images.sh --only planner-ts
# Push to registry, then:
kubectl rollout restart deployment/synesis-planner-ts -n synesis-planner
kubectl rollout status deployment/synesis-planner-ts -n synesis-planner
```

### Step 2: Tunnel to Planner-ts

In one terminal, run:

```bash
oc port-forward svc/synesis-planner-ts 8080:8080 -n synesis-planner
```

Leave this running. The planner API is now at `http://localhost:8080`.

**Alternative (Route):** If your cluster exposes planner-ts via a Route (e.g. `synesis-planner-ts.apps.your-cluster.example.com`), you can use that URL instead:

```bash
python scripts/validate-intent-live.py --url https://synesis-planner-ts.apps.your-cluster.example.com
```

### Step 3: Run Validation

In another terminal:

```bash
# From repo root
python scripts/validate-intent-live.py
# or with explicit URL
python scripts/validate-intent-live.py --url http://localhost:8080
# verbose (print response preview on failure)
python scripts/validate-intent-live.py -v
```

**Requirements:** `uv pip install --system httpx pyyaml` (or `pip install httpx pyyaml`) for full prompt set. Without them: uses stdlib urllib and inline fallback (2 prompts).

### Expected Output

```
Validating against http://localhost:8080/v1/chat/completions (5 prompts)...

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
| Unit tests | Before/after code changes | Fast feedback on planner-ts routing and graph |
| Live validation | After push + deploy | Confirms deployed release behaves as expected |

**Workflow:** Push → Deploy → `oc port-forward` → `validate-intent-live.py`. Use as a pre-release or post-deploy smoke test.

---

## 4. Customizing Prompts

- **Live / regression prompts:** Edit `tests/prompts/test_prompts.yaml` (used by `validate-intent-live.py` and prompt regression workflows).
- **Ontology + taxonomy YAML:** Under `base/planner-ts/config/` (`intent_weights.yaml`, `taxonomy_prompt_config.yaml`, `plugins/weights/`). Invalid YAML fails fast when planner-ts loads config.

---

## 5. Startup validation (planner-ts)

planner-ts loads merged ontology + taxonomy from `base/planner-ts/config/` at runtime. Structural issues surface as startup errors or test failures — extend **`base/planner-ts`** tests when adding new validation rules.

---

## 6. Security Scanning (Checkov + Grype)

Trivy was removed after the Aqua Security supply-chain compromise
([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).
**Checkov** handles IaC/Dockerfile misconfiguration scanning; **Grype**
handles vulnerability scanning. **Syft** generates CycloneDX SBOMs at
image build time (CI only).

```bash
# IaC misconfiguration scan (K8s manifests, Dockerfiles, Kustomize, Helm)
checkov -d base/ --config-file .checkov.yml

# Filesystem vulnerability scan
grype dir:. --only-fixed --fail-on high

# Generate SBOM for a local image and scan it
syft localhost/synesis-base-api:test -o cyclonedx-json > sbom.json
grype sbom:sbom.json --fail-on high
```

Install locally: `brew install checkov grype syft` (macOS) or see
[Checkov docs](https://www.checkov.io/), [Grype docs](https://github.com/anchore/grype),
[Syft docs](https://github.com/anchore/syft).

Suppressed checks are documented in `.checkov.yml` (see comments for rationale).
All first-party Dockerfiles use non-root `USER 1001` at runtime.

## 7. Supply-Chain Guardrails

CI runs a `supply-chain-guard` job that fails on compromised dependency
indicators, mutable image tags, and unpinned CI action refs. To run the same
checks locally:

```bash
# Check for residual Trivy references (should return nothing)
grep -rn 'aquasecurity/trivy' .github/workflows/
```

All commands should return no matches.
