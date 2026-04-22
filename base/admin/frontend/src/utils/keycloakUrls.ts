export const DEFAULT_KEYCLOAK_REALM = "synesis";
const REALM_PATH_RE = /\/realms\/([^/?#]+)/i;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function inferRealmIssuerFromPath(parsed: URL): string {
  const normalizedPath = trimTrailingSlash(parsed.pathname || "");
  const realmMatch = REALM_PATH_RE.exec(normalizedPath);
  if (realmMatch?.[1]) {
    const prefix = normalizedPath.slice(0, realmMatch.index);
    return trimTrailingSlash(`${parsed.origin}${prefix}/realms/${realmMatch[1]}`);
  }

  const adminIndex = normalizedPath.toLowerCase().indexOf("/admin");
  const pathPrefix =
    adminIndex >= 0
      ? normalizedPath.slice(0, adminIndex)
      : normalizedPath === "/auth"
        ? "/auth"
        : "";

  return trimTrailingSlash(`${parsed.origin}${pathPrefix}/realms/${DEFAULT_KEYCLOAK_REALM}`);
}

export function resolveKeycloakRealmIssuer(issuer?: string): string | null {
  const raw = (issuer || "").trim();
  if (!raw) return null;
  try {
    return inferRealmIssuerFromPath(new URL(raw));
  } catch {
    return null;
  }
}

export function fallbackKeycloakRealmIssuerFromHost(): string {
  const authHost = window.location.hostname
    .replace(/^admin\./, "auth.")
    .replace(/^synesis-admin\./, "synesis-auth.")
    .replace("synesis-admin", "synesis-auth");
  return `${window.location.protocol}//${authHost}/realms/${DEFAULT_KEYCLOAK_REALM}`;
}

export function resolveKeycloakRealmIssuerOrDefault(issuer?: string): string {
  return resolveKeycloakRealmIssuer(issuer) || fallbackKeycloakRealmIssuerFromHost();
}

export function getKeycloakRealmName(issuer?: string): string {
  const resolved = resolveKeycloakRealmIssuer(issuer);
  if (!resolved) return DEFAULT_KEYCLOAK_REALM;
  const realm = REALM_PATH_RE.exec(resolved)?.[1];
  return realm || DEFAULT_KEYCLOAK_REALM;
}

export function buildKeycloakAccountUrl(issuer?: string): string {
  return `${resolveKeycloakRealmIssuerOrDefault(issuer)}/account`;
}

export function buildKeycloakPasswordUrl(issuer?: string): string {
  return `${buildKeycloakAccountUrl(issuer)}/#/security/signingin`;
}
