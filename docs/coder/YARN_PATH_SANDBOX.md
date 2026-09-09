# Yarn path checks

Yarn's optional path sandbox performs lexical checks on paths visible to the proxy. The execution host must enforce filesystem permissions, symlink resolution, writable roots, and approvals. These checks do not provide process isolation or inspect arbitrary shell programs.

Implementation: [`path-sandbox.ts`](../../base/yarn-ts/src/path-governance/path-sandbox.ts). Regression coverage: [`path-sandbox.test.ts`](../../base/yarn-ts/tests/path-sandbox.test.ts).

## Current behavior

- Build policy from a known absolute execution-environment project root. The proxy's home directory and temporary directory are not client facts.
- Reject invalid path context, control characters, and home expansion without an explicitly configured home directory.
- Permit `/dev/null` as a special case.
- Apply explicit deny rules before project-root and additional allow rules.
- Allow paths inside the configured project root unless explicitly denied.
- Outside that root, require an explicit read or write grant from trusted deployment policy. The implementation recognizes exact paths and trailing `/*` or `/**` patterns, not a general glob language.
- Preserve the intended target. A denied path is not relocated into the project to make the operation pass.

There are no blanket grants for harness configuration directories, plan files, `/tmp`, or the proxy's `$TMPDIR`. Client identity and advisory request metadata do not authorize additional filesystem access. Configuration files follow the same path policy as other files.

`projectTmpDir()` suggests a scratch location; it does not grant access or create a directory. Configure the actual execution environment's scratch roots when needed.

## Configuration and integration

`SYNESIS_YARN_PATH_SANDBOX_ENABLED` controls proxy-side enforcement (code default `true`); check [`config.ts`](../../base/yarn-ts/src/config.ts) and your deployment values for the active setting. The legacy `SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE` setting does not relocate native file-tool paths.

The tool-governance pipeline checks recognized file tools and extracts some paths from common shell commands. Shell parsing is necessarily incomplete: substitutions, scripts, plugins, and remote filesystem behavior remain the execution host's responsibility. A lexical allow result is not proof that an operation is safe on disk.

For migration from the earlier home/temp allowlists, see [session execution context](../clients/SESSION_EXECUTION_CONTEXT.md#harness-compatibility-and-migration-september-2026). For client-specific metadata and schema handling, see [harness compatibility](../clients/HARNESS_COMPATIBILITY.md).
