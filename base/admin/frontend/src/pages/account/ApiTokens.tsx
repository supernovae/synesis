import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Key, Plus, Trash2, Copy, Check } from "lucide-react";
import client from "../../api/client";
import type { PersonalAccessToken, TokenCreated } from "../../types";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { useAuth } from "../../components/auth/useAuth";

type ScopeTarget = "model" | "coder";

/** User-facing names; wire format remains model:/coder: for compatibility. */
const SCOPE_LABELS: Record<ScopeTarget, string> = {
  model: "Chat API",
  coder: "Coder API",
};

function scopeDisplayLabel(scope: string): string {
  const [target] = scope.split(":") as [ScopeTarget, string];
  if (target === "model" || target === "coder") {
    return SCOPE_LABELS[target];
  }
  return scope;
}

function roleBadgeLabel(role: string): string {
  switch (role) {
    case "platform_admin":
      return "Platform admin";
    case "org_admin":
      return "Org admin";
    case "readonly":
    case "viewer":
      return "Read-only";
    case "user":
      return "User";
    default:
      return role || "Unknown";
  }
}

export default function ApiTokens() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [expiresDays, setExpiresDays] = useState<number | "">("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [lastCreatedRole, setLastCreatedRole] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [selectedTargets, setSelectedTargets] = useState<Set<ScopeTarget>>(
    () => new Set(["model"]),
  );
  const [tokenIntent, setTokenIntent] = useState<
    "admin" | "model" | "coder" | "hybrid"
  >("admin");

  const isOrgAdmin =
    user?.role === "org_admin" ||
    user?.role === "platform_admin" ||
    (user?.org_roles ?? []).includes("admin");

  function applyTokenIntent(intent: "admin" | "model" | "coder" | "hybrid") {
    setTokenIntent(intent);
    if (intent === "admin") {
      setSelectedTargets(new Set(["model"]));
      return;
    }
    if (intent === "model") {
      setSelectedTargets(new Set(["model"]));
      return;
    }
    if (intent === "coder") {
      setSelectedTargets(new Set(["coder"]));
      return;
    }
    setSelectedTargets(new Set(["model", "coder"]));
  }

  function toggleTarget(t: ScopeTarget) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        if (next.size > 1) next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  }

  /** Service scopes always use read-only suffix; access is invoke-only for these APIs. */
  function buildScopes(): string[] {
    return Array.from(selectedTargets).map((t) => `${t}:readonly`);
  }

  const { data: tokens = [], isLoading } = useQuery<PersonalAccessToken[]>({
    queryKey: ["tokens"],
    queryFn: () =>
      client.get<PersonalAccessToken[]>("/tokens").then((r) => r.data),
  });

  const createMutation = useMutation<TokenCreated, Error, void>({
    mutationFn: () =>
      client
        .post("/tokens", {
          name,
          expires_in_days: expiresDays || null,
          scopes: buildScopes(),
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      setNewToken(data.token);
      setLastCreatedRole(data.role);
      setName("");
      setExpiresDays("");
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });

  const revokeMutation = useMutation<void, Error, string>({
    mutationFn: (id) => client.delete(`/tokens/${id}`).then(() => undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tokens"] }),
  });

  function handleCopy() {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          API tokens
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Create tokens to connect third-party tools (IDEs, scripts, agents) to
          Synesis services. Each token is scoped to specific services; Synesis
          Admin REST access follows your account role.
        </p>
      </div>

      {/* Create token */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Create new token
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          <strong className="font-medium text-gray-700 dark:text-gray-300">
            Admin REST API
          </strong>{" "}
          access is controlled by your{" "}
          <strong className="font-medium">account role</strong> stored on the
          token when it is created — not by the Chat API / Coder API scope
          checkboxes below. Those scopes only gate the Chat and Coder HTTP APIs
          (and related policy checks).
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              key: "admin" as const,
              title: "Admin automation",
              subtitle: "Ingestion, governance, telemetry scripts",
            },
            {
              key: "model" as const,
              title: "Chat API",
              subtitle: "Chat / Open WebUI & compatible clients",
            },
            {
              key: "coder" as const,
              title: "Coder API",
              subtitle: "IDE & agent runtime",
            },
            {
              key: "hybrid" as const,
              title: "Hybrid",
              subtitle: "Chat API + Coder API",
            },
          ].map((intent) => (
            <button
              key={intent.key}
              type="button"
              onClick={() => applyTokenIntent(intent.key)}
              className={`rounded-md border px-3 py-2 text-left transition-colors ${
                tokenIntent === intent.key
                  ? "border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20"
                  : "border-gray-200 bg-gray-50 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
              }`}
            >
              <div className="text-xs font-semibold text-gray-900 dark:text-white">
                {intent.title}
              </div>
              <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {intent.subtitle}
              </div>
            </button>
          ))}
        </div>
        {tokenIntent === "admin" && !isOrgAdmin && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            This account is not org/platform admin. Token creation will succeed,
            but org-admin endpoints will still return 403.
          </div>
        )}
        {tokenIntent === "admin" && isOrgAdmin && (
          <div className="mt-3 rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
            Admin role detected. For global ingestion/bootstrap, platform admin
            is required; org admin remains valid for org-scoped operations.
          </div>
        )}

        {tokenIntent === "admin" && (
          <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/80 p-3 dark:border-indigo-800 dark:bg-indigo-950/30">
            <div className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
              Admin API (role-based)
            </div>
            <p className="mt-1 text-xs text-indigo-800 dark:text-indigo-300">
              This token can call{" "}
              <code className="rounded bg-indigo-100 px-1 dark:bg-indigo-900/50">
                /api/v1/…
              </code>{" "}
              according to the role captured at creation time (see &quot;API
              role&quot; on your token after you generate it). Chat API / Coder
              API scopes do not grant admin write access.
            </p>
          </div>
        )}

        <div className="mt-3 flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              Token name
            </label>
            <input
              type="text"
              placeholder="e.g., Cursor IDE"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
          <div className="w-36">
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              Expires in (days)
            </label>
            <input
              type="number"
              placeholder="Never"
              min={1}
              value={expiresDays}
              onChange={(e) =>
                setExpiresDays(e.target.value ? Number(e.target.value) : "")
              }
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Chat API &amp; Coder API (service scopes)
          </label>
          <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
            Optional access to the Chat and Coder HTTP APIs. Scopes are
            invoke-only (read-only) for these routes — they do not change Synesis
            Admin configuration. Use an org- or platform-admin account for admin
            REST automation.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(["model", "coder"] as const).map((target) => {
              const active = selectedTargets.has(target);
              return (
                <div
                  key={target}
                  className={`rounded-lg border p-3 transition-colors ${
                    active
                      ? "border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20"
                      : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
                  }`}
                >
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleTarget(target)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>
                      <span className="text-sm font-medium text-gray-900 dark:text-white">
                        {SCOPE_LABELS[target]}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                        {target === "model"
                          ? "OpenAI-compatible chat completions (Synesis Chat / pipeline front-door)."
                          : "OpenAI-compatible completions & messages for IDE and coding agents."}
                      </span>
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <ApiErrorBanner error={createMutation.error} onDismiss={() => createMutation.reset()} />

        <div className="mt-4 flex justify-end">
          <button
            onClick={() => createMutation.mutate()}
            disabled={!name || createMutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Generate token
          </button>
        </div>

        {newToken && (
          <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
            <p className="text-xs font-medium text-green-800 dark:text-green-300">
              Token created — copy it now, it won&apos;t be shown again.
              {lastCreatedRole && (
                <>
                  {" "}
                  <span className="font-normal opacity-90">
                    Admin API role:{" "}
                    <strong>{roleBadgeLabel(lastCreatedRole)}</strong>.
                  </span>
                </>
              )}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-green-100 px-2 py-1 text-xs text-green-900 dark:bg-green-800 dark:text-green-100">
                {newToken}
              </code>
              <button
                onClick={handleCopy}
                className="rounded p-1 text-green-700 hover:bg-green-200 dark:text-green-300 dark:hover:bg-green-800"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      <ApiErrorBanner error={revokeMutation.error} onDismiss={() => revokeMutation.reset()} />

      {/* Token list */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            Your tokens
          </h2>
        </div>
        {isLoading ? (
          <div className="p-4 text-center text-sm text-gray-400">Loading...</div>
        ) : tokens.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            <Key className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="mt-2">No tokens yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {tokens.map((t) => (
              <div
                key={t.id}
                className={`flex items-center justify-between px-4 py-3 ${t.revoked ? "opacity-50" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {t.name}
                    </span>
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {t.token_prefix}...
                    </code>
                    {t.revoked && (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">
                        revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      title="Role stored on this token; gates /api/v1 admin routes"
                    >
                      API role: {roleBadgeLabel(t.role)}
                    </span>
                    {t.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                        title="Chat API / Coder API service scope"
                      >
                        {scopeDisplayLabel(s)}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                    Created {new Date(t.created_at).toLocaleDateString()}
                    {t.expires_at &&
                      ` · Expires ${new Date(t.expires_at).toLocaleDateString()}`}
                    {t.last_used_at &&
                      ` · Last used ${new Date(t.last_used_at).toLocaleDateString()}`}
                  </div>
                </div>
                {!t.revoked && (
                  <button
                    onClick={() => revokeMutation.mutate(t.id)}
                    disabled={revokeMutation.isPending}
                    className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                    title="Revoke token"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
