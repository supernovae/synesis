import crypto from "node:crypto";
const MARKER = "SYNESIS_WORKSPACE_CONTEXT_V1";
export function makeWorkspaceHandshakeToolCallId() {
    return `synesis_workspace_ctx_${crypto.randomUUID()}`;
}
export function buildWorkspaceHandshakeBashCommand() {
    return [
        "cwd=\"$(pwd 2>/dev/null || true)\"",
        "root=\"$(git rev-parse --show-toplevel 2>/dev/null || true)\"",
        "shell=\"${SHELL:-${ComSpec:-${COMSPEC:-}}}\"",
        "os=\"$(uname -s 2>/dev/null || echo unknown)\"",
        "arch=\"$(uname -m 2>/dev/null || echo unknown)\"",
        "[ -z \"$root\" ] && root=\"$cwd\"",
        `printf '${MARKER}\\ncwd=%s\\nproject_root=%s\\nshell=%s\\nos=%s\\narch=%s\\n' \"$cwd\" \"$root\" \"$shell\" \"$os\" \"$arch\"`,
    ].join("; ");
}
export function hasBashTool(tools) {
    if (!Array.isArray(tools))
        return false;
    return tools.some((t) => {
        if (!t || typeof t !== "object")
            return false;
        const row = t;
        const name = row.name;
        const fnName = row.function?.name;
        return name === "Bash" || fnName === "Bash";
    });
}
export function parseWorkspaceContextOutput(raw) {
    const text = String(raw ?? "");
    const idx = text.indexOf(MARKER);
    if (idx < 0)
        return null;
    const lines = text
        .slice(idx + MARKER.length)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const kv = {};
    for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        kv[key] = val;
    }
    const cwd = normalizePath(kv.cwd);
    const root = normalizePath(kv.project_root) || cwd;
    if (!cwd || !root)
        return null;
    const shell = sanitize(kv.shell, 200);
    const os = sanitize(kv.os, 80);
    const arch = sanitize(kv.arch, 80);
    return {
        cwd,
        projectRoot: root,
        ...(shell ? { shell } : {}),
        ...(os ? { os } : {}),
        ...(arch ? { arch } : {}),
    };
}
export function extractOpenAIToolResult(messages, toolCallId) {
    const row = [...messages].reverse().find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
    if (!row)
        return null;
    if (typeof row.content === "string")
        return row.content;
    if (Array.isArray(row.content)) {
        return row.content.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n");
    }
    if (row.content == null)
        return "";
    return JSON.stringify(row.content);
}
export function extractClaudeToolResult(messages, toolCallId) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.role !== "user" || !Array.isArray(msg.content))
            continue;
        for (const block of msg.content) {
            if (!block || typeof block !== "object")
                continue;
            if (block.type !== "tool_result")
                continue;
            if (String(block.tool_use_id ?? "") !== toolCallId)
                continue;
            const c = block.content;
            if (typeof c === "string")
                return c;
            if (Array.isArray(c)) {
                return c
                    .map((part) => {
                    if (typeof part === "string")
                        return part;
                    if (part && typeof part === "object" && typeof part.text === "string") {
                        return String(part.text);
                    }
                    return JSON.stringify(part);
                })
                    .join("\n");
            }
            if (c == null)
                return "";
            return JSON.stringify(c);
        }
    }
    return null;
}
export function contextFromSessionMetadata(meta) {
    const cwd = normalizePath(String(meta.workspace_context_cwd ?? ""));
    const projectRoot = normalizePath(String(meta.workspace_context_project_root ?? ""));
    if (!cwd || !projectRoot)
        return null;
    const shell = sanitize(String(meta.workspace_context_shell ?? ""), 200);
    const os = sanitize(String(meta.workspace_context_os ?? ""), 80);
    const arch = sanitize(String(meta.workspace_context_arch ?? ""), 80);
    return {
        cwd,
        projectRoot,
        ...(shell ? { shell } : {}),
        ...(os ? { os } : {}),
        ...(arch ? { arch } : {}),
    };
}
function normalizePath(raw) {
    const t = String(raw ?? "").trim();
    if (!t)
        return "";
    return t.replace(/\0/g, "").slice(0, 2000);
}
function sanitize(raw, max) {
    return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
