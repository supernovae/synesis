# Local security boundaries

The [source-pack contract](SOURCE_PACKS.md) defines the implemented checks. The library is private to its OS user; every source in a configured library is accessible to its MCP client. Select separate libraries for separate client trust boundaries.

Pack builds require an explicit root and source list. The builder rejects symlinks and path traversal, validates UTF-8, limits archive and source sizes, and records content hashes. Imports enforce immutable pack versions; source reads are bounded and cite an exact version. Private output files are created without overwriting existing files.

The four MCP tools open the selected SQLite library read-only. Tools cannot change the library, choose arbitrary roots, import content or execute commands. CLI mutations remain explicit local operations. This is not a remote authorization service or protection against a compromised OS account.

Checksums detect changed bytes; they do not authenticate a publisher or establish that source claims are correct. Source text may contain malicious instructions. The client owns instruction handling, execution, approvals and sandboxing.

The optional saved-HTML converter reads one explicit local file and records its original hash. It does not run page scripts or fetch a URL. Source acquisition and review happen before conversion; the command does not provide a remote ingestion endpoint.

The client owns model access, tool execution and sandboxing. [Report security issues privately](../.github/SECURITY.md); automated scans and tests do not constitute a complete security audit.
