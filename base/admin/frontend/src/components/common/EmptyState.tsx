import { Inbox, type LucideIcon } from "lucide-react";

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
}

export default function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
}: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line py-12">
      <Icon className="h-10 w-10 text-fg-tertiary" />
      <h3 className="mt-3 text-sm font-medium text-fg-primary">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-fg-secondary">{description}</p>
      )}
    </div>
  );
}
