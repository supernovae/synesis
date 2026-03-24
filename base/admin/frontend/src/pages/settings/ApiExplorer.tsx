import { useState, useEffect } from "react";
import { ExternalLink, AlertTriangle } from "lucide-react";

export default function ApiExplorer() {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/openapi.json", { method: "HEAD" })
      .then((r) => setAvailable(r.ok))
      .catch(() => setAvailable(false));
  }, []);

  if (available === null) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-gray-400">
        Checking API documentation availability...
      </div>
    );
  }

  if (!available) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">API Explorer</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Interactive API documentation for the Synesis Admin service
          </p>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                OpenAPI documentation is not enabled
              </h3>
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                Set the environment variable{" "}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs dark:bg-amber-900/40">
                  SYNESIS_ENABLE_OPENAPI=true
                </code>{" "}
                on the admin deployment to enable interactive API docs.
              </p>
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                When enabled, Swagger UI will be available at{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900/40">/api/docs</code>{" "}
                and ReDoc at{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900/40">/api/redoc</code>.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">API Explorer</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Interactive API documentation for the Synesis Admin service
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href="/api/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Swagger UI <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a
            href="/api/redoc"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            ReDoc <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a
            href="/api/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            OpenAPI JSON <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <iframe
          src="/api/docs"
          title="Synesis API Documentation"
          className="h-[calc(100vh-200px)] w-full border-0"
        />
      </div>
    </div>
  );
}
