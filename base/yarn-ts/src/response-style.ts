export type MarkdownStyleMode = "off" | "guidance" | "guardrail";

export interface ResponseStyleOptions {
  mode: MarkdownStyleMode;
  allowMermaid: boolean;
  adminOverride?: string;
}

export function buildResponseStyleBlock(opts: ResponseStyleOptions): string | null {
  if (opts.mode === "off") return null;
  const override = (opts.adminOverride ?? "").trim();
  const body = override || defaultStyleBody(opts.allowMermaid);
  if (!body) return null;
  return `<RESPONSE_STYLE>\n${body}\n</RESPONSE_STYLE>`;
}

function defaultStyleBody(allowMermaid: boolean): string {
  const lines = [
    "Write polished markdown with clear structure and practical readability.",
    "- Use concise Title Case headings when sections help scanning.",
    "- Use fenced code blocks for commands and code users may copy/paste.",
    "- Prefer bullets/lists for steps and options; use tables for comparisons only.",
    "- Keep paragraphs short and avoid walls of text.",
  ];
  if (allowMermaid) {
    lines.push("- Use mermaid diagrams when describing architecture or process flow.");
  } else {
    lines.push("- Do not use mermaid diagrams unless explicitly requested by the user.");
  }
  return lines.join("\n");
}

export function applyMarkdownGuardrail(text: string, mode: MarkdownStyleMode): string {
  if (mode !== "guardrail") return text;
  let out = String(text ?? "");
  if (!out.trim()) return out;

  // Normalize heading spacing (blank line before headings except beginning).
  out = out
    .split("\n")
    .reduce<string[]>((acc, line, idx, arr) => {
      const isHeading = /^#{1,6}\s+\S/.test(line.trim());
      if (isHeading && acc.length > 0 && acc[acc.length - 1].trim() !== "") {
        acc.push("");
      }
      acc.push(line);
      const isLast = idx === arr.length - 1;
      if (isHeading && !isLast) {
        const next = arr[idx + 1] ?? "";
        if (next.trim() !== "" && !/^[-*]\s+/.test(next.trim()) && !/^\d+\.\s+/.test(next.trim())) {
          // Keep body readable under headings.
          acc.push("");
        }
      }
      return acc;
    }, [])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  // Normalize bullet markers to include a space.
  out = out.replace(/^([ \t]*[-*])([^\s-])/gm, "$1 $2");

  // Close unbalanced fenced code blocks.
  const fenceCount = (out.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) {
    out = `${out}\n\`\`\`\n`;
  }

  return out.trimEnd();
}

