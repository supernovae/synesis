# Client integration

Synesis supplies optional knowledge tools over MCP stdio. Your client keeps its native model endpoint, reasoning protocol, tools and approvals.

1. Build/import a [source pack](../SOURCE_PACKS.md) into a private local library.
2. Configure the [stdio reader](MCP_QUICKSTART.md) with an absolute library path.
3. Discover a pack/version, search evidence and follow bounded source reads.

Multiple clients can select the same library when they should have the same source access. Use separate libraries for separate trust boundaries. Absolute launch paths keep library selection independent of client cwd; the reader does not infer or control the client's project root.

Any client with suitable MCP stdio support can attempt this integration. A model or harness name is not a compatibility certificate. Reasoning, tool parsing, multimodal inputs and long-running task behavior depend on the exact client/model endpoint.

The repository checks the official MCP SDK exchange and local CLI. Validate your actual installed client by discovering a pack and reading a known source before beginning the [workflow trial](../TRIAL.md). Record the client/model versions and failures; no live model-quality result is implied by an SDK test.

Clients without local MCP stdio can use the CLI or exported sources through normal file tools. There is no hosted HTTP transport in this package.
