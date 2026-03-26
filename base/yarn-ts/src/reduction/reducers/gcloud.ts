import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

function tryParseJson(raw: string): unknown | null {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    const objStart = t.indexOf("{");
    const objEnd = t.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      try {
        return JSON.parse(t.slice(objStart, objEnd + 1));
      } catch {
        /* fall through */
      }
    }
    const arrStart = t.indexOf("[");
    const arrEnd = t.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return JSON.parse(t.slice(arrStart, arrEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function walkGcloud(val: unknown, acc: { names: string[]; statuses: string[]; zones: string[]; projects: string[] }): void {
  if (val === null || val === undefined) return;
  if (typeof val === "string") {
    const zm = val.match(/zones\/([^/]+)\//);
    if (zm) acc.zones.push(zm[1]!);
    const pm = val.match(/projects\/([^/]+)/);
    if (pm) acc.projects.push(pm[1]!);
    return;
  }
  if (Array.isArray(val)) {
    for (const v of val) walkGcloud(v, acc);
    return;
  }
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    if (typeof o.name === "string") acc.names.push(o.name);
    if (typeof o.status === "string") acc.statuses.push(o.status);
    if (typeof o.zone === "string") acc.zones.push(o.zone.split("/").pop() ?? o.zone);
    if (typeof o.projectId === "string") acc.projects.push(o.projectId);
    for (const k of Object.keys(o)) walkGcloud(o[k], acc);
  }
}

function parseGcloudTable(lines: string[]): { header: string; rows: string[] } {
  let header = "";
  const rows: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("Listed") || t.startsWith("Using")) continue;
    if (/^(NAME|ZONE|STATUS|LOCATION|PROJECT)\s+/i.test(t) && t.includes("  ")) {
      header = t.replace(/\s+/g, " ");
      continue;
    }
    if (header && /^[\w@./-][\w@./-]*\s{2,}/i.test(t)) {
      rows.push(t.replace(/\s+/g, " ").trim());
    }
  }
  return { header, rows };
}

export class GcloudReducer implements Reducer {
  readonly family = "gcloud" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const acc: { names: string[]; statuses: string[]; zones: string[]; projects: string[] } = {
      names: [],
      statuses: [],
      zones: [],
      projects: []
    };
    const parsed = tryParseJson(raw);
    const detailLines: string[] = [];
    let resourceCount = 0;

    if (parsed !== null) {
      walkGcloud(parsed, acc);
      const uniqNames = [...new Set(acc.names)];
      resourceCount = Array.isArray(parsed) ? parsed.length : uniqNames.length > 0 ? uniqNames.length : 1;
      uniqNames.slice(0, 8).forEach((n) => detailLines.push(`name: ${n}`));
      [...new Set(acc.statuses)].slice(0, 4).forEach((s) => detailLines.push(`status: ${s}`));
      [...new Set(acc.zones)].slice(0, 4).forEach((z) => detailLines.push(`zone: ${z}`));
      [...new Set(acc.projects)].slice(0, 3).forEach((p) => detailLines.push(`project: ${p}`));
    }

    const table = parseGcloudTable(raw.split("\n"));
    if (table.header) detailLines.push(`table: ${table.header}`);
    if (table.rows.length > 0) {
      resourceCount = Math.max(resourceCount, table.rows.length);
      const limit = input.context.profile === "ultra" ? 6 : 12;
      table.rows.slice(0, limit).forEach((r) => detailLines.push(r));
      if (table.rows.length > limit) detailLines.push(`... ${table.rows.length - limit} more rows`);
    }

    if (resourceCount === 0 && detailLines.length === 0) return null;

    const limit = input.context.profile === "ultra" ? 8 : 18;
    const parts: string[] = [`<TOOL_REDUCED family="gcloud" resources="${resourceCount}">`];
    detailLines.slice(0, limit).forEach((d) => parts.push(`  ${d}`));
    if (detailLines.length > limit) parts.push(`  ... ${detailLines.length - limit} more`);
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.88,
      actionableCount: resourceCount,
      summary: parts.join("\n")
    };
  }
}
