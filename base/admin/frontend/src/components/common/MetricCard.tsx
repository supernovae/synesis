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
        "rounded-lg border border-gray-200 bg-white p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
          {subtitle && (
            <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div className="rounded-lg bg-gray-50 p-2">
            <Icon className="h-5 w-5 text-gray-400" />
          </div>
        )}
      </div>
      {trend && trendValue && (
        <p
          className={clsx(
            "mt-2 text-xs font-medium",
            trend === "up" && "text-green-600",
            trend === "down" && "text-red-600",
            trend === "neutral" && "text-gray-500",
          )}
        >
          {trend === "up" ? "+" : trend === "down" ? "-" : ""}
          {trendValue}
        </p>
      )}
    </div>
  );
}
