# Harness compatibility

Synesis exposes [four read-only knowledge tools over MCP stdio](MCP_QUICKSTART.md). It does not detect harness names, rewrite model requests, provide an ACP bridge, or inject workspace metadata.

| Boundary | Owner and behavior |
| --- | --- |
| Model endpoint, reasoning history and native API | The chat/coding client and provider. |
| Project root, cwd changes and concurrent sessions | The client's execution environment. |
| Tools, shell access, approvals and sandboxing | The client. Synesis knowledge tools only read their selected library. |
| Knowledge library selection | Explicit absolute path in the server launch arguments. |
| Source version and evidence limits | Exact pack/version on search/read; bounded results and continuation offsets. |
| Client access separation | Separate local libraries for different intended source access. |

Hermes Agent, DeepSeek Harness, Qwen clients and other named harnesses do not receive special proxy adapters. Use the installed client's documented MCP stdio integration if available. A model name does not establish client capabilities or identify a harness. Clients without a suitable MCP transport can use exported source files through their native file tools.

Repository tests exercise the official MCP SDK client/server exchange, closed tool arguments, an unrelated cwd, read-only access and shutdown. They do not certify each named client or every upstream release. When investigating an integration issue, record the exact client/version, launch arguments and a public or synthetic source example.

The earlier project-root headers, hooks, PAT flows, transcript shims and ACP adapters were removed with Planner/Yarn. Native client behavior is the default. A future compatibility fix needs an observed failure and a narrow protocol contract; a harness popularity list is not a reason to add interception.

See [model compatibility](../model-compatibility.md) for separate endpoint and serving considerations.
