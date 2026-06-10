import React, { useState } from "react";
import { clsx } from "clsx";

interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  keyField: string;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  className?: string;
  headerSlot?: React.ReactNode;
}

export default function DataTable<T extends object>({
  columns,
  data,
  keyField,
  emptyMessage = "No data available",
  onRowClick,
  className,
  headerSlot,
}: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = sortKey
    ? [...data].sort((a, b) => {
        const va = (a as Record<string, unknown>)[sortKey];
        const vb = (b as Record<string, unknown>)[sortKey];
        const cmp =
          typeof va === "number" && typeof vb === "number"
            ? va - vb
            : String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : data;

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-fg-secondary">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "overflow-x-auto rounded-lg border border-line",
        className,
      )}
    >
      <table className="min-w-full divide-y divide-line">
        <thead className="bg-canvas-tertiary">
          <tr>
            {columns.map((col, idx) => {
              if (idx === 0 && headerSlot) return <React.Fragment key={col.key}>{headerSlot}</React.Fragment>;
              return (
                <th
                  key={col.key}
                  className={clsx(
                    "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-fg-secondary",
                    col.sortable && "cursor-pointer select-none hover:text-fg-primary",
                    col.className,
                  )}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    {col.sortable && sortKey === col.key && (
                      <span>{sortDir === "asc" ? "\u2191" : "\u2193"}</span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line bg-surface-card">
          {sorted.map((row) => (
            <tr
              key={String((row as Record<string, unknown>)[keyField])}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={clsx(
                onRowClick && "cursor-pointer hover:bg-surface-hover",
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={clsx(
                    "whitespace-nowrap px-4 py-3 text-sm text-fg-primary",
                    col.className,
                  )}
                >
                  {col.render
                    ? col.render(row)
                    : String((row as Record<string, unknown>)[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
