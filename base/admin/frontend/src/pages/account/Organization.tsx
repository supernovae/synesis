import { useAuth } from "../../components/auth/AuthProvider";
import { Building2, Users, Mail, ExternalLink } from "lucide-react";

export default function Organization() {
  const { user } = useAuth();
  const keycloakAccountUrl = `${window.location.origin.replace("synesis-admin", "synesis-auth")}/realms/synesis/account`;

  if (!user) return null;

  const hasOrg = Boolean(user.org_name);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Organization
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your organization membership and account details
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
              <Building2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                {hasOrg ? user.org_name : "Individual Account"}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {hasOrg ? "Organization member" : "No organization membership"}
              </p>
            </div>
          </div>

          {hasOrg && (
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500 dark:text-gray-400">Organization ID</dt>
                <dd className="font-mono text-xs text-gray-700 dark:text-gray-300">{user.org_id}</dd>
              </div>
              {user.org_roles && user.org_roles.length > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Org Roles</dt>
                  <dd className="flex gap-1">
                    {user.org_roles.map((r) => (
                      <span
                        key={r}
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                      >
                        {r}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {!hasOrg && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              You can join an organization if you receive an invitation link from
              an organization administrator, or ask a platform admin to create one
              for your team.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
              <Users className="h-5 w-5 text-gray-600 dark:text-gray-400" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                Account Details
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Your Keycloak identity
              </p>
            </div>
          </div>

          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                <Mail className="h-3.5 w-3.5" /> Email
              </dt>
              <dd className="text-gray-700 dark:text-gray-300">{user.username}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500 dark:text-gray-400">Role</dt>
              <dd className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {user.role}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500 dark:text-gray-400">User ID</dt>
              <dd className="font-mono text-xs text-gray-500 dark:text-gray-500">{user.user_id?.slice(0, 8)}...</dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-gray-100 pt-4 dark:border-gray-800">
            <a
              href={keycloakAccountUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Manage account in Keycloak
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
