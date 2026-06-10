import type { LucideIcon } from "lucide-react";
import { clsx } from "clsx";

interface Props {
  label: string;
  value: string | number;
  subtitle?: string | undefined;
  icon?: LucideIcon;
  trend?: "up" | "down" | "neutral";
  trendValue?: string;
  className?: string;
}

export default function MetricCard({
  label,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendValue,
  className,
}: Props) {
  return (
    <div
      className={clsx(
        "rounded-lg border border-line bg-surface-card p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-fg-secondary">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-fg-primary">{value}</p>
          {subtitle && (
            <p className="mt-0.5 text-xs text-fg-tertiary">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div className="rounded-lg bg-canvas-secondary p-2">
            <Icon className="h-5 w-5 text-fg-tertiary" />
          </div>
        )}
      </div>
      {trend && trendValue && (
        <p
          className={clsx(
            "mt-2 text-xs font-medium",
            trend === "up" && "text-green-600 dark:text-green-400",
            trend === "down" && "text-red-600 dark:text-red-400",
            trend === "neutral" && "text-fg-secondary",
          )}
        >
          {trend === "up" ? "+" : trend === "down" ? "-" : ""}
          {trendValue}
        </p>
      )}
    </div>
  );
}
