/**
 * Bounded linear-pass shaping for TTY-shaped CLI output (ANSI, \\r redraws, repetition).
 * No nested backtracking; caps input size for safety.
 */

export const DEFAULT_MAX_SHAPER_INPUT_CHARS = 2_000_000;

export interface ShapingStats {
  ansiEscapeBytesRemoved: number;
  carriageReturnSegmentsCollapsed: number;
  repeatedLineRunsCollapsed: number;
  inputChars: number;
  outputChars: number;
}

export interface ShapeTerminalOutputResult {
  text: string;
  shapingApplied: string[];
  stats: ShapingStats;
}

/** Strip common CSI SGR and similar ESC sequences (linear scan). */
export function stripAnsiEscapes(input: string): { text: string; removed: number } {
  let removed = 0;
  let out = "";
  const n = input.length;
  for (let i = 0; i < n; ) {
    const c = input.charCodeAt(i);
    if (c !== 0x1b) {
      out += input[i];
      i += 1;
      continue;
    }
    removed += 1;
    i += 1;
    if (i >= n) break;
    const next = input.charCodeAt(i);
    // ESC [ ... letter
    if (next === 0x5b) {
      i += 1;
      while (i < n) {
        const ch = input.charCodeAt(i);
        i += 1;
        if (ch >= 0x40 && ch <= 0x7e) break;
      }
      continue;
    }
    // ESC ] OSC ... BEL or ST
    if (next === 0x5d) {
      i += 1;
      while (i < n) {
        const ch = input.charCodeAt(i);
        i += 1;
        if (ch === 0x07) break;
        if (ch === 0x1b && i < n && input.charCodeAt(i) === 0x5c) {
          i += 1;
          break;
        }
      }
      continue;
    }
    // ESC (,), etc. — skip one more byte if present
    if (i < n) {
      removed += 1;
      i += 1;
    }
  }
  return { text: out, removed };
}

/**
 * Normalize \\r / \\r\\n so carriage-return-only progress lines collapse to one line per logical row.
 */
export function normalizeCarriageReturns(input: string): { text: string; crCollapses: number } {
  let crCollapses = 0;
  const withNl = input.replace(/\r\n/g, "\n");
  const parts = withNl.split("\n");
  const out: string[] = [];
  for (const part of parts) {
    if (!part.includes("\r")) {
      out.push(part);
      continue;
    }
    const segs = part.split("\r");
    crCollapses += Math.max(0, segs.length - 1);
    out.push(segs[segs.length - 1] ?? "");
  }
  return { text: out.join("\n"), crCollapses };
}

const MAX_REPEAT_TRACK = 10_000;

/**
 * Collapse consecutive identical non-empty lines: `line` × N → `line (×N)`.
 */
export function collapseRepeatedLines(input: string): { text: string; runsCollapsed: number } {
  const lines = input.split(/\n/);
  if (lines.length === 0) return { text: input, runsCollapsed: 0 };
  const out: string[] = [];
  let prev = lines[0];
  let run = 1;
  let runsCollapsed = 0;

  const flush = (): void => {
    if (run <= 1) {
      out.push(prev);
      return;
    }
    const trimmed = prev.trimEnd();
    if (trimmed.length === 0) {
      for (let k = 0; k < run; k++) out.push(prev);
      return;
    }
    runsCollapsed += 1;
    const cap = Math.min(run, MAX_REPEAT_TRACK);
    out.push(`${prev.trimEnd()} (×${cap}${run > cap ? "+" : ""})`);
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === prev) {
      run += 1;
      if (run > MAX_REPEAT_TRACK) run = MAX_REPEAT_TRACK;
    } else {
      flush();
      prev = line;
      run = 1;
    }
  }
  flush();

  return { text: out.join("\n"), runsCollapsed };
}

export function shapeTerminalOutput(
  raw: string,
  options?: { maxInputChars?: number; skip?: boolean },
): ShapeTerminalOutputResult {
  const maxIn = options?.maxInputChars ?? DEFAULT_MAX_SHAPER_INPUT_CHARS;
  if (options?.skip) {
    const slice = raw.length > maxIn ? raw.slice(0, maxIn) : raw;
    return {
      text: slice,
      shapingApplied: [],
      stats: {
        ansiEscapeBytesRemoved: 0,
        carriageReturnSegmentsCollapsed: 0,
        repeatedLineRunsCollapsed: 0,
        inputChars: raw.length,
        outputChars: slice.length,
      },
    };
  }

  const input = raw.length > maxIn ? raw.slice(0, maxIn) : raw;
  const shapingApplied: string[] = [];

  const a = stripAnsiEscapes(input);
  if (a.removed > 0) {
    shapingApplied.push("ansi_stripped");
  }

  const b = normalizeCarriageReturns(a.text);
  if (b.crCollapses > 0) {
    shapingApplied.push("carriage_returns_collapsed");
  }

  const c = collapseRepeatedLines(b.text);
  if (c.runsCollapsed > 0) {
    shapingApplied.push("repeated_lines_collapsed");
  }

  return {
    text: c.text,
    shapingApplied,
    stats: {
      ansiEscapeBytesRemoved: a.removed,
      carriageReturnSegmentsCollapsed: b.crCollapses,
      repeatedLineRunsCollapsed: c.runsCollapsed,
      inputChars: raw.length,
      outputChars: c.text.length,
    },
  };
}
