# Contributing

Synesis is a local source-pack builder and reader. Start with the [README](README.md), [source-pack contract](docs/SOURCE_PACKS.md), and [architecture decisions](docs/ARCHITECTURE.md).

Use Node.js 24.14 or newer. A full development install includes the repository linter:

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run lint
```

The core has no model credentials, server, database daemon or Python prerequisite. Tests use real SQLite and an MCP subprocess. The knowledge workflow also checks Node 24/26 and installation of the packed artifact outside this workspace.

For Python preparation work, install Python 3.12, uv and ShellCheck. `make quality` runs lint, formatting, shell and documentation checks; `make quality-full` also builds/tests the core, checks the lockfile validator with local wheel fixtures, and runs saved-HTML tests in an isolated Python environment. Dependency installation may require network access. The checks make no model calls.

```bash
make quality
make quality-full
make install-hooks
```

The optional [saved-HTML command](tools/prepare-html/README.md) declares its dependencies inline. Its generated lockfile drives the isolated test/audit environment. The [trial helper](docs/TRIAL.md) uses the built Node core and official MCP SDK; its integration tests run with the core tests.

For intentional dependency updates, edit the relevant manifest or inline script declaration and regenerate its lockfile. `npm ci` must work without falling back to `npm install`. The Python environment uses `./scripts/lock-deps.sh`; `--check` validates existing pins against requirements without demanding every available upstream update. Review audit findings and test the resulting environment.

Preserve explicit roots, immutable versions, bounded reads and clear citations. Keep model calls, planning, execution and approvals with the client. Add a behavior workaround only for an observed failure with a narrow contract and a retirement condition.

Use public or synthetic test sources. Keep private sources, built packs, SQLite libraries and credentials out of commits and issue reports. Document measured results separately from hypotheses; protocol tests do not establish model-quality gains. Security reports follow the [security policy](.github/SECURITY.md).
