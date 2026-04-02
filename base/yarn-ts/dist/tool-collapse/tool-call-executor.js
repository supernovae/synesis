/**
 * Executes validated collapsed ops in plan order. Passthrough ops are not executed here.
 */
export async function executeCollapsePlan(plan, executor) {
    const out = [];
    for (let i = 0; i < plan.operations.length; i++) {
        const op = plan.operations[i];
        if (op.kind === "passthrough") {
            out.push({
                operationIndex: i,
                kind: "passthrough",
                payload: { calls: op.calls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input })) },
            });
            continue;
        }
        if (!executor) {
            out.push({
                operationIndex: i,
                kind: op.kind,
                payload: null,
                error: "executor_not_configured",
            });
            continue;
        }
        try {
            let payload;
            if (op.kind === "batch_read") {
                const b = op;
                payload = await executor.batchRead(b.paths);
            }
            else if (op.kind === "batch_search") {
                const s = op;
                payload = await executor.batchSearch(s.items);
            }
            else if (op.kind === "repo_context") {
                const r = op;
                payload = await executor.repoContext(r.search, r.reads.map((x) => x.path));
            }
            else if (op.kind === "merge_patch") {
                const m = op;
                payload = await executor.mergePatch(m.files.map((f) => ({ path: f.path, patch: f.patch })));
            }
            else if (op.kind === "run_tests") {
                const t = op;
                payload = await executor.runTests(t.command);
            }
            else {
                payload = null;
            }
            out.push({ operationIndex: i, kind: op.kind, payload });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            out.push({ operationIndex: i, kind: op.kind, payload: null, error: msg });
        }
    }
    return out;
}
