/**
 * Bridge between M2 reducer output and M1 enrichment engine.
 *
 * Reducers parse tool output into items (messages with optional file/ruleId).
 * This module classifies each item using M1's deterministic classifiers and
 * appends Root cause / Action lines to the reducer summary.
 *
 * The bridge avoids duplicating classifiers — M1's enrichment.ts is the
 * single source of truth for error family classification.
 */
import { classifyErrorFamily, getNextAction, getRootCause } from "../validation/enrichment.js";
import { getLanguagePackRegistry } from "../language-packs/index.js";
/**
 * Map from M2 ReducerFamily names to M1 ValidationFamily names.
 * Only validator-family reducers are mapped; non-validator reducers
 * (git, search, docker-build, etc.) are not enrichment targets.
 */
const FAMILY_MAP = {
    pytest: "pytest",
    tsc: "typescript",
    lint: "eslint",
    mypy: "mypy",
    pylint: "pylint",
    cargo: "cargo",
    clippy: "cargo",
    terraform: "terraform",
    jest: "jest",
    "go-build": "go",
    shellcheck: "shellcheck",
    rubocop: "rubocop",
    cppcheck: "cppcheck",
    "java-build": "java",
    gradle: "java",
    dotnet: "dotnet",
    "sql-result": "sqlfluff",
};
/**
 * Enrich a list of parsed items from a reducer.
 *
 * For the "lint" reducer which handles both ESLint and Ruff output,
 * pass `lintSubFamily` to select the right classifier.
 */
export function enrichItems(reducerFamily, items, lintSubFamily) {
    const validationFamily = lintSubFamily ?? FAMILY_MAP[reducerFamily];
    if (!validationFamily) {
        return { items: items.map(toUnenriched), enrichedLines: [], bypassEligible: false };
    }
    const enriched = [];
    const lines = [];
    let classified = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const ef = classifyErrorFamily(validationFamily, item.message, item.ruleId);
        const rc = ef ? getRootCause(validationFamily, ef) : undefined;
        const act = ef ? getNextAction(validationFamily, ef, item.file) : undefined;
        enriched.push({
            message: item.message,
            file: item.file,
            ruleId: item.ruleId,
            errorFamily: ef,
            rootCause: rc,
            action: act
        });
        lines.push(`  ${i + 1}. ${item.message}`);
        if (rc)
            lines.push(`     Root cause: ${rc}`);
        if (act)
            lines.push(`     Action: ${act}`);
        if (ef)
            classified++;
    }
    const bypassEligible = items.length > 0 && classified === items.length;
    return { items: enriched, enrichedLines: lines, bypassEligible };
}
function toUnenriched(item) {
    return { message: item.message, file: item.file, ruleId: item.ruleId };
}
/** Check whether a reducer family is enrichment-eligible. */
export function isEnrichable(reducerFamily) {
    if (reducerFamily in FAMILY_MAP)
        return true;
    const registry = getLanguagePackRegistry();
    if (registry.size > 0) {
        return registry.getAllPacks().some((p) => p.reducerFamilies.includes(reducerFamily) && Object.keys(p.classifiers).length > 0);
    }
    return false;
}
