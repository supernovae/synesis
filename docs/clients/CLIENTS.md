# Client integration

The current local Synesis package supplies optional knowledge tools over MCP stdio. Keep your chat/coding client's native model endpoint, reasoning protocol, tools and approvals. There is no required Synesis model gateway or extra planning loop in this path.

1. Build and import a [source pack](../SOURCE_PACKS.md) into an absolute private library directory.
2. Configure the [MCP stdio reader](MCP_QUICKSTART.md) using your client's supported settings.
3. Discover a pack version, then search/read evidence through the four read-only knowledge tools.

The same library can be selected by multiple local clients that have the same intended source access. Use separate libraries for separate access boundaries. Absolute paths keep source selection independent of the client's cwd; the reader never infers or controls its project root.

The contract is MCP stdio, not recognition of a client name. An installed model/client's native protocol capabilities determine reasoning, images, audio, execution and long-running task behavior. Synesis does not claim those capabilities on the client's behalf.

Existing client-specific pages for the previous Planner/Yarn platform remain implementation references during extraction. Their proxy endpoints, PAT/OIDC flows and hooks are not setup requirements or supported aliases for the new local reader. The [architecture decision record](../ARCHITECTURE_REVIEW.md) tracks the remaining platform removals and optional hosted work.
