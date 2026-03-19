import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Key, Plus, Trash2, Copy, Check } from "lucide-react";
import type { AxiosResponse } from "axios";
import client from "../../api/client";
import type { PersonalAccessToken, TokenCreated } from "../../types";

export default function ApiTokens() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [expiresDays, setExpiresDays] = useState<number | "">("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tokens = [], isLoading } = useQuery<PersonalAccessToken[]>({
    queryKey: ["tokens"],
    queryFn: () => client.get("/tokens").then((r: AxiosResponse<PersonalAccessToken[]>) => r.data),
  });

  const createMutation = useMutation<TokenCreated, Error, void>({
    mutationFn: () =>
      client
        .post("/tokens", {
          name,
          expires_in_days: expiresDays || null,
        })
        .then((r: AxiosResponse<TokenCreated>) => r.data),
    onSuccess: (data) => {
      setNewToken(data.token);
      setName("");
      setExpiresDays("");
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
  });

  const revokeMutation = useMutation<void, Error, string>({
    mutationFn: (id) => client.delete(`/tokens/${id}`),
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
        <h1 className="text-2xl font-bold text-gray-900">API Tokens</h1>
        <p className="mt-1 text-sm text-gray-500">
          Generate personal access tokens for programmatic API access (Cursor,
          Claude Code, scripts).
        </p>
      </div>

      {/* Create token */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-700">
          Create new token
        </h2>
        <div className="mt-3 flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-gray-500">Token name</label>
            <input
              type="text"
              placeholder="e.g., Cursor IDE"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="w-36">
            <label className="block text-xs text-gray-500">
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
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!name || createMutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Generate
          </button>
        </div>

        {newToken && (
          <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3">
            <p className="text-xs font-medium text-green-800">
              Token created — copy it now, it won't be shown again:
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-green-100 px-2 py-1 text-xs text-green-900">
                {newToken}
              </code>
              <button
                onClick={handleCopy}
                className="rounded p-1 text-green-700 hover:bg-green-200"
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

      {/* Token list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-700">Your tokens</h2>
        </div>
        {isLoading ? (
          <div className="p-4 text-center text-sm text-gray-400">
            Loading...
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            <Key className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-2">No tokens yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {tokens.map((t) => (
              <div
                key={t.id}
                className={`flex items-center justify-between px-4 py-3 ${t.revoked ? "opacity-50" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      {t.name}
                    </span>
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                      {t.token_prefix}...
                    </code>
                    {t.revoked && (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">
                        revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-400">
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
                    className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
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
