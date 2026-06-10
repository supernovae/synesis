# Synesis Comparison Notes

This page keeps the comparison material out of the top-level README. It is not
a leaderboard. It is a positioning guide for deciding when Synesis is the right
kind of project to run or fork.

## Where Synesis Fits

Synesis is closest to an **AI control plane**: model routing, graph-native RAG,
chat, coding agents, MCP tooling, admin operations, security events, and review
workflows in one self-hosted stack.

| Capability | Synesis | AI SDK / LlamaIndex | Dify / Flowise | Cursor / Continue | Perplexity / Glean |
|---|---|---|---|---|---|
| Self-hosted control plane | Yes | Framework only | Partial | No | No |
| Air-gap friendly architecture | Yes, with self-hosted models and internal data plane | Depends on what you build | Depends on deployment | No | No |
| Chat plus coding agents | Yes | Build it yourself | Mostly chat/RAG | Coding only | Search/answering |
| MCP integration | Built in | Build it yourself | Limited or custom | Client-side only | No |
| Graph-native RAG | NornicDB vector + graph search | Bring your own | Basic workflow RAG | Not primary surface | Proprietary search |
| Admin operations UI | Models, providers, keys, RAG review, traces, security events | No | Basic UI | No | SaaS admin |
| Trust/provenance controls | TrustPacketV1, attribution, scan status, review status | Build it yourself | Limited | Limited | Source links |
| Multi-role model routing | Planner, writer, coder, critic, summarizer, embedder | Build it yourself | Usually single workflow model | Usually one coding model | Proprietary |
| Forkable platform code | Yes | Yes, as libraries | Yes, app/workflow layer | Limited by product | No |

## Choose Synesis When

- You want one platform for chat, RAG, coding agents, MCP, and model operations.
- Your data and model traffic need to stay in your infrastructure.
- Operators need a UI for providers, model registry, RAG review, security
  events, traces, and feedback.
- You want to extend the system with new indexers, tools, model adapters, or
  deployment patterns.
- You want provenance, authorization, and trust metadata attached to retrieved
  context rather than handled as prompt convention.

## Choose A Smaller Tool When

- You only need a single chatbot over a small document set.
- You want a library, not an operated platform.
- You do not need Kubernetes, model governance, RAG review, security event
  tracking, or IDE agent integration.
- You prefer SaaS speed over self-hosted control.

## Related Docs

- [Top-level README](../README.md)
- [Helm install](HELM_INSTALL.md)
- [MCP quickstart](clients/MCP_QUICKSTART.md)
- [Security posture](SECURITY.md)
- [Graph-native RAG](RAG.md)
