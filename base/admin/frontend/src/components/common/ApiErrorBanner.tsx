import { apiErrorMessage } from "../../api/errorMessage";

/** Inline error from a mutation or API call; DRY across admin pages. */
export function ApiErrorBanner({
  error,
  onDismiss,
}: {
  error?: unknown;
  onDismiss?: () => void;
}) {
  if (error == null) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/40">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-red-800 dark:text-red-200">{apiErrorMessage(error)}</p>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 text-xs font-medium text-red-700 underline hover:text-red-900 dark:text-red-300"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
