# Synesis Yarn: OpenAI Compatibility and Value-Add Architecture (Python — retired)

The Python Yarn runtime has been removed. OpenAI compatibility for the TypeScript runtime is covered in [`base/yarn-ts/README.md`](../../base/yarn-ts/README.md); use that README plus `base/yarn-ts/tests/` for `/v1` contract behavior. That README includes a short **“OpenAI and Claude: model reasoning (thinking)”** section (streaming `reasoning_content`, non-stream `message.reasoning_content`, and how this differs from Anthropic `thinking` blocks on `POST /v1/messages`).

For the active TypeScript Yarn implementation, see [`base/yarn-ts/`](../../base/yarn-ts/).
