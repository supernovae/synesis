# Is Synesis a fit?

Synesis combines chat and coder APIs, knowledge retrieval, MCP tools, and an admin surface in a self-hosted platform. This page describes the operating tradeoffs; it does not rank other products or claim feature parity with them.

## When to evaluate it

- You want shared model configuration and indexed knowledge across chat and coding clients.
- You need to inspect retrieval provenance, session traces, review state, or model usage.
- You want to extend service code, indexers, tools, or model compatibility handling.
- Your team can operate the backing services, identity provider, storage, and model endpoints.

## What running it involves

| Need | Synesis approach | Responsibility to plan for |
| --- | --- | --- |
| Local evaluation | Compose stack with optional service profiles | Configure a model endpoint; default startup is a smoke test. |
| Platform deployment | Kubernetes Helm chart and examples | Identity, secrets, networking, storage, upgrades, and monitoring. |
| Private knowledge | Indexed documents/code and NornicDB retrieval | Ingestion quality, source permissions, freshness, and review. |
| Coding integration | Coder API, ACP bridge, and MCP tools | Client/version validation and the native execution sandbox. |
| Model choice | Configured self-hosted or hosted endpoints | Model availability, licensing, cost, serving features, and workload evaluation. |
| Disconnected operation | Deployment can use internally hosted components | Mirror required artifacts and remove external service dependencies. |

A smaller application or library may be easier to maintain if you only need one chatbot, a retrieval component, or a single model endpoint. Synesis is most useful when the shared platform capabilities justify the additional services.

See the [README](../README.md), [local setup](LOCAL_COMPOSE.md), [deployment guide](HELM_INSTALL.md), [security model](SECURITY.md), and [compatibility limits](clients/HARNESS_COMPATIBILITY.md) before choosing a deployment scope.
