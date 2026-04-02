import crypto from "node:crypto";
import { sortObjectKeys } from "../compat/sorted-tools.js";
import { NEVER_COLLAPSE_NAMES, classifyTool, extractPatch, } from "../tool-collapse/tool-call-collapser.js";
function stableArgsJson(input) {
    if (input === null || input === undefined)
        return "null";
    if (typeof input === "string") {
        try {
            const j = JSON.parse(input);
            return JSON.stringify(sortObjectKeys(j));
        }
        catch {
            return JSON.stringify(input);
        }
    }
    if (typeof input === "object") {
        return JSON.stringify(sortObjectKeys(input));
    }
    return JSON.stringify(input);
}
export function hashToolCall(toolName, input) {
    const payload = `${normToolName(toolName)}\0${stableArgsJson(input)}`;
    return crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
function normToolName(name) {
    return name.trim().toLowerCase().replace(/-/g, "_");
}
/**
 * Tools safe for consecutive exact dedupe (no execution / side-effect in Yarn’s model).
 * Patches: only when byte-identical payload (handled via hash).
 */
function isExactDedupeEligible(c) {
    if (NEVER_COLLAPSE_NAMES.has(c.toolName))
        return false;
    const k = classifyTool(c.toolName);
    if (k === "run_tests")
        return false;
    if (k === "passthrough") {
        const n = normToolName(c.toolName);
        if (/^(curl|wget|fetch|http)/.test(n))
            return false;
        if (n.includes("network") || n.includes("webhook"))
            return false;
        return (n === "list_files" ||
            n === "list_dir" ||
            n === "glob_file_search" ||
            n === "get_metadata" ||
            n === "file_search");
    }
    return k === "read_file" || k === "search" || k === "apply_patch";
}
/**
 * Consecutive identical tool calls (same hash) → keep first, drop rest.
 * apply_patch: only deduped when full args hash matches (byte-equivalent JSON-stable encoding).
 */
export function stripConsecutiveExactDuplicates(calls, log, emit) {
    const duplicateOf = new Map();
    const droppedIds = [];
    if (calls.length === 0) {
        return { calls: [], duplicateOf, droppedIds };
    }
    const out = [];
    let prevHash = null;
    let prevId = null;
    let prevEligible = false;
    for (const c of calls) {
        const eligible = isExactDedupeEligible(c);
        const h = eligible ? hashToolCall(c.toolName, c.input) : null;
        if (eligible && h !== null && prevEligible && h === prevHash && prevId !== null) {
            duplicateOf.set(c.toolCallId, prevId);
            droppedIds.push(c.toolCallId);
            emit?.({
                kind: "exact_duplicate_tool_call",
                message: "dedupe: exact duplicate tool call",
                toolCallIds: [c.toolCallId],
                detail: `canonical=${prevId}`,
            });
            log.push({
                phase: "collapse",
                detail: `dedupe_exact_duplicate: ${c.toolCallId} -> ${prevId}`,
                atMs: Date.now(),
                originalIds: [c.toolCallId],
            });
            continue;
        }
        out.push(c);
        if (eligible && h !== null) {
            prevHash = h;
            prevId = c.toolCallId;
            prevEligible = true;
        }
        else {
            prevHash = null;
            prevId = null;
            prevEligible = false;
        }
    }
    return { calls: out, duplicateOf, droppedIds };
}
/**
 * Strict: only identical patch body + path (via extractPatch) produces same hash when whole input stable.
 */
export function patchCallsAreByteIdentical(a, b) {
    if (classifyTool(a.toolName) !== "apply_patch" || classifyTool(b.toolName) !== "apply_patch") {
        return false;
    }
    const pa = extractPatch(a.input);
    const pb = extractPatch(b.input);
    if (!pa || !pb)
        return false;
    return pa.path === pb.path && pa.patch === pb.patch;
}
