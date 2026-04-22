import axios from "axios";
import { TOKEN_KEY, clearPersistedAuth, refreshAccessToken } from "../utils/oidcSession";

const client = axios.create({
  baseURL: "/api/v1",
  headers: { "Content-Type": "application/json" },
});

let isRefreshing = false;
let refreshQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(token: string | null, error: unknown = null) {
  for (const p of refreshQueue) {
    if (error) p.reject(error);
    else p.resolve(token!);
  }
  refreshQueue = [];
}

async function attemptRefresh(): Promise<string | null> {
  return refreshAccessToken({ retries: 2, retryDelayMs: 1_500 });
}

client.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshQueue.push({
          resolve: (token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(client(originalRequest));
          },
          reject,
        });
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    const newToken = await attemptRefresh();
    isRefreshing = false;

    if (newToken) {
      processQueue(newToken);
      originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return client(originalRequest);
    }

    processQueue(null, error);
    clearPersistedAuth();
    // Preserve the current path so the user returns here after re-auth
    const current = window.location.pathname + window.location.search;
    if (current && current !== "/login" && current !== "/callback") {
      sessionStorage.setItem("synesis_return_to", current);
    }
    window.location.replace("/login");
    return Promise.reject(error);
  },
);

export default client;
