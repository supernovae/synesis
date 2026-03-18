import { useNavigate, useParams } from "react-router-dom";
import { useFailureDetail } from "../../api/hooks";

export default function ErrorDetail() {
  const { failureId } = useParams<{ failureId: string }>();
  const navigate = useNavigate();
  const { data: failure, isLoading, isError } = useFailureDetail(failureId ?? "");

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (isError || !failure) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => navigate("/observability/errors")}
          className="text-sm text-indigo-600 hover:underline"
        >
          &larr; Back to Error Log
        </button>
        <p className="text-gray-500">Failure not found.</p>
      </div>
    );
  }

  const ts = failure.timestamp
    ? new Date(Number(failure.timestamp) * 1000).toLocaleString()
    : "—";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate("/observability/errors")}
          className="text-sm text-indigo-600 hover:underline"
        >
          &larr; Back to Error Log
        </button>
        <h1 className="text-2xl font-semibold text-gray-900">
          Error Detail
        </h1>
      </div>

      <div className="rounded-lg border bg-white shadow-sm divide-y">
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Field label="Error Type">
            <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
              {failure.error_type || "unknown"}
            </span>
          </Field>
          <Field label="Language">{failure.language || "—"}</Field>
          <Field label="Exit Code">{failure.exit_code ?? "—"}</Field>
          <Field label="Timestamp">{ts}</Field>
        </div>

        <div className="p-4">
          <Field label="Failure ID">
            <code className="text-xs text-gray-600 break-all">{failure.failure_id}</code>
          </Field>
        </div>

        <div className="p-4">
          <Field label="Task Description">
            <p className="whitespace-pre-wrap text-sm text-gray-700">
              {failure.task_description || "—"}
            </p>
          </Field>
        </div>

        {failure.error_output && (
          <div className="p-4">
            <Field label="Error Output">
              <pre className="mt-1 max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs text-red-700 whitespace-pre-wrap">
                {failure.error_output}
              </pre>
            </Field>
          </div>
        )}

        {failure.code && (
          <div className="p-4">
            <Field label="Code">
              <pre className="mt-1 max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap">
                {failure.code}
              </pre>
            </Field>
          </div>
        )}

        {failure.resolution && (
          <div className="p-4">
            <Field label="Resolution">
              <pre className="mt-1 max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs text-green-700 whitespace-pre-wrap">
                {failure.resolution}
              </pre>
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{children}</dd>
    </div>
  );
}
