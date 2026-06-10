import { OpenFgaClient, CredentialsMethod } from "@openfga/sdk";
import { canonicalSecurityId } from "@synesis/auth-contracts";
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

  const clientConfig: ConstructorParameters<typeof OpenFgaClient>[0] = {
    apiUrl,
    storeId,
  };
  if (modelId) clientConfig.authorizationModelId = modelId;
  if (authToken) {
    clientConfig.credentials = { method: CredentialsMethod.ApiToken, config: { token: authToken } };
  }
  fgaClient = new OpenFgaClient(clientConfig);
}

export async function fgaCheckMcpTools(userId: string): Promise<{ allowed: boolean; resolution?: string }> {
  if (!fgaClient) {
    return { allowed: false, resolution: "openfga_not_configured" };
  }
  try {
    const safeUserId = canonicalSecurityId(userId, "user_id");
    const response = await fgaClient.check({
      user: `user:${safeUserId}`,
      relation: "can_invoke",
      object: "yarn_endpoint:completions",
    });
    const result: { allowed: boolean; resolution?: string } = {
      allowed: response.allowed ?? false,
    };
    if (response.resolution) result.resolution = response.resolution;
    return result;
  } catch (err) {
    return {
      allowed: false,
      resolution: `openfga_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
