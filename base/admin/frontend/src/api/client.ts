import axios from "axios";
import {
  CSRF_COOKIE_KEY,
  CSRF_HEADER_KEY,
  clearPersistedAuth,
  getCookie,
  refreshSession,
} from "../utils/oidcSession";

const client = axios.create({
  baseURL: "/api/v1",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

let isRefreshing = false;
let refreshQueue: Array<{
  resolve: () => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown = null) {
  for (const p of refreshQueue) {
    if (error) p.reject(error);
    else p.resolve();
  }
  refreshQueue = [];
}

client.interceptors.request.use((config) => {
  const method = (config.method || "get").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS", "TRACE"].includes(method)) {
    const csrf = getCookie(CSRF_COOKIE_KEY);
    if (csrf) {
      config.headers[CSRF_HEADER_KEY] = csrf;
    }
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (!originalRequest || error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshQueue.push({
          resolve: () => resolve(client(originalRequest)),
          reject,
        });
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    const user = await refreshSession({ retries: 2, retryDelayMs: 1_500 });
    isRefreshing = false;

    if (user) {
      processQueue();
      return client(originalRequest);
    }

    processQueue(error);
    clearPersistedAuth();
    const current = window.location.pathname + window.location.search;
    if (current && current !== "/login" && current !== "/callback") {
      sessionStorage.setItem("synesis_return_to", current);
    }
    window.location.replace("/login");
    return Promise.reject(error);
  },
);

export default client;
