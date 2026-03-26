import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class LsTreeReducer implements Reducer {
  readonly family = "ls-tree" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n").filter((l) => l.trim());
    if (lines.length < 15) return null;

    const dirs = new Set<string>();
    const files: string[] = [];
    const treeLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[d-][rwx-]{9}/.test(trimmed) || trimmed.startsWith("total ")) {
        const parts = trimmed.split(/\s+/);
        const name = parts[parts.length - 1];
        if (trimmed.startsWith("d")) dirs.add(name);
        else files.push(name);
      } else if (/^[│├└─\s]+/.test(trimmed) || /^[|+\\`\-\s]+/.test(trimmed)) {
        treeLines.push(trimmed);
      } else if (/^\.\//.test(trimmed) || /^\//.test(trimmed)) {
        const lastSlash = trimmed.lastIndexOf("/");
        if (lastSlash > 0) dirs.add(trimmed.slice(0, lastSlash));
        files.push(trimmed);
      } else {
        files.push(trimmed);
      }
    }

    const totalEntries = dirs.size + files.length + treeLines.length;
    if (totalEntries < 10) return null;

    const limit = input.context.profile === "ultra" ? 15 : 30;
    const parts: string[] = [`<TOOL_REDUCED family="ls-tree" entries="${totalEntries}" dirs="${dirs.size}" files="${files.length}">`];
    if (treeLines.length > 0) {
      treeLines.slice(0, limit).forEach((l) => parts.push(l));
      if (treeLines.length > limit) parts.push(`... ${treeLines.length - limit} more entries`);
    } else {
      if (dirs.size > 0) parts.push(`dirs: ${[...dirs].slice(0, 10).join(", ")}${dirs.size > 10 ? ` (+${dirs.size - 10})` : ""}`);
      const topFiles = files.slice(0, limit);
      topFiles.forEach((f) => parts.push(`  ${f}`));
      if (files.length > limit) parts.push(`  ... ${files.length - limit} more files`);
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.8, actionableCount: 0, summary: parts.join("\n") };
  }
}
