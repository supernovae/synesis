import { Link } from "react-router-dom";
import { useAuth } from "../../components/auth/useAuth";
import {
  Building2,
  ExternalLink,
  KeyRound,
  Shield,
  User,
} from "lucide-react";

/** Keycloak Account Console — password, email, 2FA (realm synesis). */
function keycloakAccountUrl(): string {
  return `${window.location.origin.replace("synesis-admin", "synesis-auth")}/realms/synesis/account`;
}

export default function AccountHome() {
  const { user } = useAuth();
  if (!user) return null;

  const kcUrl = keycloakAccountUrl();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Account
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your identity, organization, and credentials for the Synesis Admin API
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
              <User className="h-5 w-5 text-gray-600 dark:text-gray-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Profile & sign-in
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Managed in Keycloak
              </p>
            </div>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500 dark:text-gray-400">Username</dt>
              <dd className="text-right text-gray-900 dark:text-gray-100">
                {user.username}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500 dark:text-gray-400">Dashboard role</dt>
              <dd className="flex items-center gap-1.5">
                {user.role === "admin" ? (
                  <Shield className="h-3.5 w-3.5 text-blue-500" />
                ) : null}
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  {user.role}
                </span>
              </dd>
            </div>
            {user.user_id && (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500 dark:text-gray-400">User ID</dt>
                <dd className="font-mono text-xs text-gray-600 dark:text-gray-400">
                  {user.user_id.slice(0, 12)}…
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Password, email, and security settings are not stored in Synesis.
            Use Keycloak&apos;s account console to change your password or update
            your profile.
          </p>
          <a
            href={kcUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Open Keycloak account
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
              <Building2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Organization
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Membership and org roles from Keycloak
              </p>
            </div>
          </div>
          {user.org_name ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">{user.org_name}</span>
              {user.org_roles && user.org_roles.length > 0 && (
                <span className="text-gray-500 dark:text-gray-400">
                  {" "}
                  · {user.org_roles.join(", ")}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No organization membership on your account.
            </p>
          )}
          <Link
            to="/account/organization"
            className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            View organization details →
          </Link>
        </div>

        <div className="md:col-span-2 rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-900/20">
              <KeyRound className="h-5 w-5 text-amber-700 dark:text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                API tokens (Synesis Admin)
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Programmatic access to this admin service
              </p>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Personal access tokens are issued by the <strong>Synesis Admin API</strong>{" "}
            (<code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">syn-…</code>
            ). Use them in <code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">Authorization: Bearer</code>{" "}
            for scripts (e.g. bootstrap), <code className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">curl</code>, and
            automation. They are <strong>not</strong> a separate &quot;Cursor-only&quot;
            product — the same tokens work wherever the docs say to send a PAT to
            Synesis Admin. Other products (IDEs, Yarn) may accept the same format
            when documented.
          </p>
          <Link
            to="/account/tokens"
            className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Create and manage tokens →
          </Link>
        </div>
      </div>
    </div>
  );
}
