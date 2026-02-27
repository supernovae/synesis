# RAG Stack (OpenShift AI 3)

Synesis RAG uses a **simple Milvus standalone deployment** (no Milvus Operator). This matches the approach used by RHOAI 3's Llama Stack documentation.

## Components

| Component | Purpose |
|-----------|---------|
| **milvus-standalone.yaml** | etcd + Milvus standalone Deployments, Service `synesis-milvus` on port 19530 |
| **embedder/** | TEI (sentence-transformers/all-MiniLM-L6-v2) for indexers and planner |
| **indexers/** | Code, apispec, architecture, license indexers populate Milvus |

## Optional: LlamaStackDistribution

If you have **Llama Stack Operator** enabled in OpenShift AI 3, you can optionally add the full Llama Stack RAG (OpenAI-compatible APIs). See `llamastack-distribution.yaml` for the CR and secret setup instructions.

The LlamaStackDistribution connects to the same Milvus (`synesis-milvus`) and can use your deployed vLLM models. It is **not required** for Synesis — our planner and indexers work with Milvus + embedder directly.

## vLLM: Use RHOAI Built-in Only

Deploy models via the OpenShift AI dashboard. **Do not use Docker Hub vLLM images** — they failed on RHOAI v2 due to Python path issues. Use the platform's built-in vLLM ServingRuntime.
