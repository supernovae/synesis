import { OpenFgaClient, CredentialsMethod } from "@openfga/sdk";
let fgaClient = null;
export function initFgaClient(config) {
    const apiUrl = config.SYNESIS_OPENFGA_API_URL;
    const storeId = config.SYNESIS_OPENFGA_STORE_ID;
    const authToken = config.SYNESIS_OPENFGA_AUTH_TOKEN;
    const modelId = config.SYNESIS_OPENFGA_MODEL_ID;
    if (!apiUrl || !storeId)
        return;
    fgaClient = new OpenFgaClient({
        apiUrl,
        storeId,
        authorizationModelId: modelId || undefined,
        credentials: authToken
            ? { method: CredentialsMethod.ApiToken, config: { token: authToken } }
            : undefined,
    });
}
export function getFgaClient() {
    return fgaClient;
}
export async function fgaCheck(user, relation, objectType, objectId) {
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
    }
    catch (err) {
        return {
            allowed: false,
            resolution: `openfga_error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export async function fgaHealthy() {
    if (!fgaClient)
        return false;
    try {
        await fgaClient.readAuthorizationModels({ pageSize: 1 });
        return true;
    }
    catch {
        return false;
    }
}
