#!/usr/bin/env bash
# Apply ModelCar deployments with ECR_REGISTRY override.
#
# Usage:
#   ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com \
#     ./scripts/apply-modelcar-deployments.sh
#
# Or export first:
#   export ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com
#   ./scripts/apply-modelcar-deployments.sh

set -euo pipefail

ECR_REGISTRY="${ECR_REGISTRY:-123456789012.dkr.ecr.us-east-1.amazonaws.com}"
NAMESPACE="${NAMESPACE:-synesis-models}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_SERVING="$REPO_ROOT/base/model-serving"

export ECR_REGISTRY

echo "Applying ModelCar deployments (ECR_REGISTRY=$ECR_REGISTRY, namespace=$NAMESPACE)"
oc apply -n "$NAMESPACE" -f <(envsubst < "$MODEL_SERVING/deployment-modelcar-executor.yaml")
oc apply -n "$NAMESPACE" -f <(envsubst < "$MODEL_SERVING/deployment-modelcar-supervisor.yaml")
oc apply -n "$NAMESPACE" -f <(envsubst < "$MODEL_SERVING/deployment-modelcar-critic.yaml")
echo "Done. Check: oc get pods -n $NAMESPACE -l 'app in (synesis-executor,synesis-supervisor,synesis-critic)'"
