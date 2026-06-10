import type { ReactNode } from "react";
import { clsx } from "clsx";

interface Props {
  title: string;
  subtitle?: string | undefined;
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
        "rounded-lg border border-line bg-surface-card p-5",
        className,
      )}
    >
      <div className="mb-4">
        <h3 className="text-sm font-medium text-fg-primary">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-fg-tertiary">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
