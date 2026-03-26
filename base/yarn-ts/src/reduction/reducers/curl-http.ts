import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class CurlHttpReducer implements Reducer {
  readonly family = "curl-http" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");
    let statusLine = "";
    let contentType = "";
    let bodyStart = -1;
    const headers: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^(HTTP\/[\d.]+)\s+(\d{3})/.test(trimmed)) {
        statusLine = trimmed;
      } else if (/^(>|<|\*)\s/.test(trimmed)) {
        if (trimmed.startsWith("< ") && /content-type:/i.test(trimmed)) {
          contentType = trimmed.replace(/^<\s*/, "");
        }
        headers.push(trimmed);
      } else if (trimmed === "" && statusLine && bodyStart < 0) {
        bodyStart = i + 1;
      }
    }

    if (!statusLine && headers.length < 3) return null;

    const bodyLines = bodyStart >= 0 ? lines.slice(bodyStart) : lines;
    const bodyPreview = bodyLines.join("\n").slice(0, input.context.profile === "ultra" ? 200 : 500).trim();

    const parts: string[] = [`<TOOL_REDUCED family="curl-http" headers="${headers.length}">`];
    if (statusLine) parts.push(statusLine);
    if (contentType) parts.push(contentType);
    if (bodyPreview) {
      parts.push("body preview:");
      parts.push(bodyPreview);
      if (bodyLines.join("\n").length > bodyPreview.length) parts.push("...(truncated)");
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.85, actionableCount: 0, summary: parts.join("\n") };
  }
}
