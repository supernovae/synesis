/* eslint-disable @typescript-eslint/no-explicit-any -- preserve the previous default response typing for existing callers */
import {
  CSRF_COOKIE_KEY,
  CSRF_HEADER_KEY,
  clearPersistedAuth,
  getCookie,
  refreshSession,
} from "../utils/oidcSession";

export interface ApiResponse<T = any> {
  data: T;
  status: number;
  headers: Headers;
}

export interface ApiRequestConfig {
  params?: Record<string, unknown> | URLSearchParams | undefined;
  headers?: HeadersInit | undefined;
  signal?: AbortSignal | undefined;
  withCredentials?: boolean | undefined;
  data?: unknown;
}

export class ApiClientError extends Error {
  response: ApiResponse<unknown> | undefined;

  constructor(message: string, response?: ApiResponse<unknown>) {
    super(message);
    this.name = "ApiClientError";
    this.response = response;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

let redirectingToLogin = false;

function resolveUrl(url: string, params?: ApiRequestConfig["params"]): string {
  const baseUrl = url.startsWith("http") || url.startsWith("/api/") ? url : `/api/v1${url}`;
  const search = new URLSearchParams();
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) search.append(key, value);
  } else if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item != null) search.append(key, String(item));
        }
      } else {
        search.append(key, String(value));
      }
    }
  }
  const query = search.toString();
  if (!query) return baseUrl;
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${query}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return JSON.parse(text);
  return text;
}

function requestHeaders(method: string, body: unknown, config?: ApiRequestConfig): Headers {
  const headers = new Headers(config?.headers);
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (isForm && headers.get("Content-Type")?.startsWith("multipart/form-data")) {
    headers.delete("Content-Type");
  }
  if (body !== undefined && !isForm && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!SAFE_METHODS.has(method)) {
    const csrf = getCookie(CSRF_COOKIE_KEY);
    if (csrf) headers.set(CSRF_HEADER_KEY, csrf);
  }
  return headers;
}

function requestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (
    typeof body === "string" ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams ||
    (typeof FormData !== "undefined" && body instanceof FormData)
  ) {
    return body;
  }
  return JSON.stringify(body);
}

function redirectToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  clearPersistedAuth();
  const current = window.location.pathname + window.location.search;
  if (current && current !== "/login" && current !== "/callback") {
    sessionStorage.setItem("synesis_return_to", current);
  }
  window.location.replace("/login");
}

async function request<T>(
  method: string,
  url: string,
  data?: unknown,
  config?: ApiRequestConfig,
  retry = true,
): Promise<ApiResponse<T>> {
  const upperMethod = method.toUpperCase();
  const init: RequestInit = {
    method: upperMethod,
    headers: requestHeaders(upperMethod, data, config),
    credentials: "include",
  };
  const body = requestBody(data);
  if (body !== undefined) init.body = body;
  if (config?.signal) init.signal = config.signal;

  const response = await fetch(resolveUrl(url, config?.params), init);
  const responseData = await parseResponseBody(response);
  const apiResponse = { data: responseData as T, status: response.status, headers: response.headers };
  if (response.ok) return apiResponse;

  const error = new ApiClientError(response.statusText || "Request failed", apiResponse);
  if (response.status !== 401 || !retry) throw error;

  const user = await refreshSession({ retries: 2, retryDelayMs: 1_500 });
  if (user) return request<T>(method, url, data, config, false);

  redirectToLogin();
  throw error;
}

const client = {
  get<T = any>(url: string, config?: ApiRequestConfig) {
    return request<T>("GET", url, undefined, config);
  },
  post<T = any>(url: string, data?: unknown, config?: ApiRequestConfig) {
    return request<T>("POST", url, data, config);
  },
  put<T = any>(url: string, data?: unknown, config?: ApiRequestConfig) {
    return request<T>("PUT", url, data, config);
  },
  patch<T = any>(url: string, data?: unknown, config?: ApiRequestConfig) {
    return request<T>("PATCH", url, data, config);
  },
  delete<T = any>(url: string, config?: ApiRequestConfig) {
    return request<T>("DELETE", url, config?.data, config);
  },
};

export default client;
