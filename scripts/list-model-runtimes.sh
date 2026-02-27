#!/usr/bin/env bash
# List available ServingRuntimes and ClusterServingRuntimes for model deployment.
# Use this when InferenceServices show "waiting for runtime to become available"
# or when patching the runtime field in base/model-serving/*.yaml.
set -euo pipefail

echo "=== ServingRuntimes (namespace-scoped) ==="
oc get servingruntimes -A 2>/dev/null | head -20 || echo "  (none or CRD not installed)"

echo ""
echo "=== ClusterServingRuntimes (cluster-scoped) ==="
if oc get crd clusterservingruntimes.serving.kserve.io &>/dev/null; then
  oc get clusterservingruntimes 2>/dev/null | head -20 || echo "  (none)"
else
  echo "  (ClusterServingRuntime CRD not installed)"
fi

echo ""
echo "=== In synesis-models ==="
oc get servingruntimes -n synesis-models 2>/dev/null || echo "  (none)"

echo ""
echo "Synesis deploy.sh creates ServingRuntimes: synesis-supervisor, synesis-executor, synesis-critic"
echo "(from vllm-spyre-x86 and vllm-cuda templates). InferenceService runtime field matches these names."
