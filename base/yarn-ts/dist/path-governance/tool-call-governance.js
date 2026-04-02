import path from "node:path";
import { constrainFileToolPathToProjectRoot, normalizeFileToolArgs, validateToolArgs, } from "../providers/model-adapter.js";
export function governToolCall(opts) {
    const out = {
        toolName: opts.toolName,
        input: { ...opts.input },
        normalizedPath: false,
        constrainedToRoot: false,
        blockedBashDrift: false,
        validationMissing: [],
    };
    const pathNorm = normalizeFileToolArgs(out.toolName, out.input);
    if (pathNorm.normalized) {
        out.input = pathNorm.input;
        out.normalizedPath = true;
    }
    const anchorRoot = resolvedAnchorRoot(opts.projectRoot, opts.shellCwd);
    if (opts.enforcePathRoot && anchorRoot) {
        const rootClamp = constrainFileToolPathToProjectRoot(anchorRoot, out.toolName, out.input);
        if (rootClamp.constrained) {
            out.input = rootClamp.input;
            out.constrainedToRoot = true;
        }
    }
    if (opts.blockBashPathDrift && out.toolName === "Bash") {
        const command = out.input.command;
        if (typeof command === "string" && command.trim()) {
            const drift = detectBashPathDrift(command, opts.shellCwd);
            if (drift) {
                const msg = `Synesis Yarn blocked risky shell path drift: ${drift.reason}. Stay in the current project root and use relative paths.`;
                out.input = {
                    command: `echo ${shellEscape(msg)} >&2; exit 2`,
                    description: "Blocked risky mkdir/cd path drift",
                };
                out.blockedBashDrift = true;
            }
        }
    }
    const validation = validateToolArgs(out.toolName, out.input);
    if (!validation.valid) {
        out.validationMissing = validation.missing;
    }
    return out;
}
function resolvedAnchorRoot(projectRoot, shellCwd) {
    const root = (projectRoot ?? "").trim();
    if (root)
        return root;
    const cwd = (shellCwd ?? "").trim();
    return cwd || null;
}
function detectBashPathDrift(command, shellCwd) {
    const shellBase = normalizedBase(shellCwd);
    const mkdirCd = command.match(/mkdir(?:\s+-p)?\s+([^\s;&|]+)\s*&&\s*cd\s+([^\s;&|]+)/);
    if (mkdirCd) {
        const mkdirTarget = stripQuotes(mkdirCd[1]);
        const cdTarget = stripQuotes(mkdirCd[2]);
        if (mkdirTarget === cdTarget && shellBase && path.basename(mkdirTarget) === shellBase) {
            return { reason: `mkdir&&cd repeats current directory segment '${shellBase}'` };
        }
        if (hasDuplicateAdjacentSegment(mkdirTarget) || hasDuplicateAdjacentSegment(cdTarget)) {
            return { reason: "mkdir/cd target contains duplicated adjacent segments" };
        }
    }
    const cdMatches = command.matchAll(/(?:^|[;&|]\s*|\s+)cd\s+([^\s;&|]+)/g);
    for (const m of cdMatches) {
        const target = stripQuotes(m[1]);
        if (hasDuplicateAdjacentSegment(target)) {
            return { reason: `cd target '${target}' contains duplicated adjacent segments` };
        }
    }
    return null;
}
function normalizedBase(raw) {
    const t = (raw ?? "").trim();
    if (!t)
        return null;
    const b = path.basename(t);
    return b && b !== "." && b !== ".." ? b : null;
}
function stripQuotes(s) {
    return s.replace(/^['"`]+|['"`]+$/g, "").trim();
}
function hasDuplicateAdjacentSegment(rawPath) {
    const cleaned = stripQuotes(rawPath).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const parts = cleaned
        .split("/")
        .filter((p) => p.length > 0 && p !== "." && p !== ".." && p !== "~")
        .map((p) => p.replace(/\*+$/g, ""));
    for (let i = 1; i < parts.length; i += 1) {
        if (parts[i] && parts[i] === parts[i - 1])
            return true;
    }
    return false;
}
function shellEscape(s) {
    if (/^[a-zA-Z0-9_./:-]+$/.test(s))
        return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}
