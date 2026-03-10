# Synesis Makefile
# Run from project root.
# Prerequisites: pip install -r base/planner/requirements-test.txt (from base/planner)

.PHONY: mock-tests online-tests tests help

# Offline tests: routing, API contract, E2E with mocked LLMs. No network or real services.
mock-tests:
	cd base/planner && python -m pytest tests/test_graph_routing.py tests/test_routing_parity.py tests/test_api.py tests/test_e2e_graph.py -v

# Online tests: hit live planner via oc port-forward. Requires:
#   oc port-forward svc/synesis-planner 8000:8000 -n synesis-planner
online-tests:
	python scripts/validate-intent-live.py --url http://localhost:8000

# All unit/mock tests (alias)
tests: mock-tests

help:
	@echo "mock-tests   - Run offline tests (routing, API, E2E with mocks)"
	@echo "online-tests - Run validation against live planner (oc port-forward required)"
	@echo "tests       - Alias for mock-tests"
