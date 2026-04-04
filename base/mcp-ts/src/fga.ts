import { OpenFgaClient, CredentialsMethod } from "@openfga/sdk";
import type { McpTsConfig } from "./config.js";

let fgaClient: OpenFgaClient | null = null;

export function getFgaClient(): OpenFgaClient | null {
  return fgaClient;
}

export function initFgaClient(config: McpTsConfig): void {
  const apiUrl = config.SYNESIS_OPENFGA_API_URL;
  const storeId = config.SYNESIS_OPENFGA_STORE_ID;
  const authToken = config.SYNESIS_OPENFGA_AUTH_TOKEN;
  const modelId = config.SYNESIS_OPENFGA_MODEL_ID;

  if (!apiUrl || !storeId) return;

  fgaClient = new OpenFgaClient({
    apiUrl,
    storeId,
    authorizationModelId: modelId || undefined,
    credentials: authToken
      ? { method: CredentialsMethod.ApiToken, config: { token: authToken } }
      : undefined,
  });
}

export async function fgaCheckMcpTools(userId: string): Promise<{ allowed: boolean; resolution?: string }> {
  if (!fgaClient) {
    return { allowed: false, resolution: "openfga_not_configured" };
  }
  try {
    const response = await fgaClient.check({
      user: `user:${userId}`,
      relation: "can_invoke",
      object: "yarn_endpoint:completions",
    });
    return {
      allowed: response.allowed ?? false,
      resolution: response.resolution ?? undefined,
    };
  } catch (err) {
    return {
      allowed: false,
      resolution: `openfga_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
