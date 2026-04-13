import { OpenFgaClient, CredentialsMethod } from "@openfga/sdk";
import type { AppConfig } from "../config.js";

let fgaClient: OpenFgaClient | null = null;

export function initFgaClient(config: AppConfig): void {
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

export interface FgaCheckResult {
  allowed: boolean;
  resolution?: string;
}

let fgaCheckOverride: ((user: string, relation: string, objectType: string, objectId: string) => FgaCheckResult) | null = null;

/** Override fgaCheck for testing. Pass null to reset. */
export function setFgaCheckOverride(fn: typeof fgaCheckOverride): void {
  fgaCheckOverride = fn;
}

export async function fgaCheck(
  user: string,
  relation: string,
  objectType: string,
  objectId: string,
): Promise<FgaCheckResult> {
  if (fgaCheckOverride) return fgaCheckOverride(user, relation, objectType, objectId);
  if (!fgaClient) {
    return { allowed: false, resolution: "openfga_not_configured" };
  }
  try {
    const response = await fgaClient.check({
      user,
      relation,
      object: `${objectType}:${objectId}`,
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

