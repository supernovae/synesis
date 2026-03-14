import type { ReactNode } from "react";
import { clsx } from "clsx";

interface Props {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export default function ChartCard({
  title,
  subtitle,
  children,
  className,
}: Props) {
  return (
    <div
      className={clsx(
        "rounded-lg border border-gray-200 bg-white p-5",
        className,
      )}
    >
      <div className="mb-4">
        <h3 className="text-sm font-medium text-gray-900">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
