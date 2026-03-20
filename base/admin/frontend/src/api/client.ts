import axios from "axios";

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
  const refresh = localStorage.getItem("synesis_refresh_token");
  if (!refresh) return null;
  try {
    const { data } = await axios.post("/api/v1/auth/oauth/refresh", {
      refresh_token: refresh,
    });
    const newAccess = data.access_token as string;
    localStorage.setItem("synesis_token", newAccess);
    if (data.refresh_token) {
      localStorage.setItem("synesis_refresh_token", data.refresh_token);
    }
    if (data.expires_in) {
      const expiresAt = Date.now() + (data.expires_in as number) * 1000;
      localStorage.setItem("synesis_token_expires_at", String(expiresAt));
    }
    return newAccess;
  } catch {
    return null;
  }
}

client.interceptors.request.use((config) => {
  const token = localStorage.getItem("synesis_token");
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
    localStorage.removeItem("synesis_token");
    localStorage.removeItem("synesis_refresh_token");
    localStorage.removeItem("synesis_token_expires_at");
    localStorage.removeItem("synesis_user");
    window.location.href = "/login";
    return Promise.reject(error);
  },
);

export default client;
