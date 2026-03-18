import { useState, useMemo } from "react";
import MarkdownContent from "./MarkdownContent";
import { Code, Eye, FileText, Copy, Check } from "lucide-react";

type ContentKind = "json" | "markdown" | "text";

const MARKDOWN_SIGNALS = /(?:^#{1,6}\s|\*\*\w|^[-*]\s|^\d+\.\s|```|^\|.*\|)/m;

function detectKind(text: string): ContentKind {
  const trimmed = text.trim();

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON — fall through
    }
  }

  if (MARKDOWN_SIGNALS.test(trimmed)) {
    return "markdown";
  }

  return "text";
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return text;
  }
}

function JsonHighlight({ text }: { text: string }) {
  const formatted = useMemo(() => formatJson(text), [text]);

  const highlighted = useMemo(() => {
    return formatted.replace(
      /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match, key, str, bool, num) => {
        if (key)
          return `<span class="text-purple-600 dark:text-purple-400">${key}</span>:`;
        if (str)
          return `<span class="text-green-600 dark:text-green-400">${str}</span>`;
        if (bool)
          return `<span class="text-amber-600 dark:text-amber-400">${bool}</span>`;
        if (num)
          return `<span class="text-blue-600 dark:text-blue-400">${num}</span>`;
        return match;
      },
    );
  }, [formatted]);

  return (
    <pre
      className="max-h-[32rem] overflow-y-auto overflow-x-auto whitespace-pre rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300"
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

const KIND_LABELS: Record<ContentKind, { label: string; Icon: typeof Code }> = {
  json: { label: "JSON", Icon: Code },
  markdown: { label: "Rich", Icon: Eye },
  text: { label: "Text", Icon: FileText },
};

export default function RichContent({
  content,
  className = "",
  maxHeight = "max-h-[32rem]",
  defaultView,
}: {
  content: string;
  className?: string;
  maxHeight?: string;
  defaultView?: "raw" | "rich";
}) {
  const kind = useMemo(() => detectKind(content), [content]);
  const canRender = kind !== "text";
  const [showRaw, setShowRaw] = useState(
    defaultView === "raw" || !canRender,
  );
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const { label, Icon } = KIND_LABELS[kind];

  return (
    <div className={`group relative ${className}`}>
      {/* Toolbar */}
      <div className="mb-1 flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
          <Icon className="h-3 w-3" />
          {label}
        </span>

        {canRender && (
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            {showRaw ? (
              <>
                <Eye className="h-3 w-3" /> Render
              </>
            ) : (
              <>
                <Code className="h-3 w-3" /> Raw
              </>
            )}
          </button>
        )}

        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-green-500" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>

      {/* Content */}
      {showRaw ? (
        <pre
          className={`${maxHeight} overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300`}
        >
          {content}
        </pre>
      ) : kind === "json" ? (
        <JsonHighlight text={content} />
      ) : (
        <div
          className={`${maxHeight} overflow-y-auto rounded border border-gray-200 bg-white p-3 dark:border-gray-600 dark:bg-gray-900`}
        >
          <MarkdownContent content={content} className="text-xs" />
        </div>
      )}
    </div>
  );
}
