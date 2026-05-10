import type { PoolConfig } from "pg";

function normalizePgConnectionString(connectionString: string): string {
  const trimmed = connectionString.trim();
  if (!trimmed) return "";
  const nodePgUrl = trimmed.replace(/^postgresql\+asyncpg:/i, "postgresql:");

  try {
    const url = new URL(nodePgUrl);
    const ssl = url.searchParams.get("ssl");
    if (ssl && !url.searchParams.has("sslmode")) {
      url.searchParams.delete("ssl");
      url.searchParams.set("sslmode", ssl);
      if (ssl.toLowerCase() === "require" && !url.searchParams.has("uselibpqcompat")) {
        url.searchParams.set("uselibpqcompat", "true");
      }
    }
    return url.toString();
  } catch {
    return nodePgUrl;
  }
}

export function buildPgPoolConfig(connectionString: string, max: number): PoolConfig {
  return {
    connectionString: normalizePgConnectionString(connectionString),
    max,
  };
}

