import { clsx } from "clsx";

type Variant = "ok" | "healthy" | "strong" | "adequate" | "warning" | "degraded" | "weak" | "error" | "offline" | "empty" | "open" | "closed" | "half_open" | "pending" | "approved" | "rejected" | "up" | "down";

const styles: Record<string, string> = {
  ok: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950 dark:text-green-400 dark:ring-green-400/20",
  healthy: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950 dark:text-green-400 dark:ring-green-400/20",
  strong: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950 dark:text-green-400 dark:ring-green-400/20",
  approved: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950 dark:text-green-400 dark:ring-green-400/20",
  closed: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950 dark:text-green-400 dark:ring-green-400/20",
  up: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950 dark:text-green-400 dark:ring-green-400/20",
  adequate: "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-400 dark:ring-blue-400/20",
  warning: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-400/20",
  degraded: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-400/20",
  weak: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-400/20",
  half_open: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-400/20",
  pending: "bg-gray-50 text-gray-600 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-400/20",
  error: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  offline: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  empty: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  open: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  rejected: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  down: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
};

const fallback = "bg-gray-50 text-gray-600 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-400/20";

interface Props {
  status: Variant;
  label?: string;
}

export default function StatusBadge({ status, label }: Props) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        styles[status] || fallback,
      )}
    >
      {label || status}
    </span>
  );
}
