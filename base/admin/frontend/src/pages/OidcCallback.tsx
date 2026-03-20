import { useEffect, useRef, useState } from "react";
import { useAuth } from "../components/auth/useAuth";
import axios from "axios";

const SUPPRESS_AUTO_KEY = "synesis_oidc_suppress_auto";

export default function OidcCallback() {
  const { oidcConfig } = useAuth();
  const [error, setError] = useState("");
  const exchangeStarted = useRef(false);

  useEffect(() => {
    async function exchangeCode() {
      const params = new URLSearchParams(window.location.search);
      const oauthError = params.get("error");
      const oauthDesc = params.get("error_description");
      const code = params.get("code");

      if (oauthError) {
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        const msg = oauthDesc
          ? decodeURIComponent(oauthDesc.replace(/\+/g, " "))
          : oauthError;
        setError(msg || "Sign-in was cancelled or denied");
        return;
      }

      if (!code) {
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        setError("No authorization code received");
        return;
      }

      if (!oidcConfig?.enabled || !oidcConfig.issuer || !oidcConfig.client_id) {
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        setError("OIDC not configured");
        return;
      }

      const verifier = sessionStorage.getItem("synesis_pkce_verifier");
      if (!verifier) {
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        setError("PKCE verifier missing — please try logging in again");
        return;
      }

      if (exchangeStarted.current) {
        return;
      }
      exchangeStarted.current = true;

      const redirectUri = `${window.location.origin}/callback`;

      try {
        const { data } = await axios.post<{
          access_token: string;
          token_type?: string;
          refresh_token?: string;
          expires_in?: number;
          id_token?: string;
        }>("/api/v1/auth/oauth/token", {
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });

        const accessToken = data.access_token;

        sessionStorage.removeItem("synesis_pkce_verifier");
        sessionStorage.removeItem(SUPPRESS_AUTO_KEY);

        // Persist tokens.
        localStorage.setItem("synesis_token", accessToken);
        if (data.id_token) {
          localStorage.setItem("synesis_id_token", data.id_token);
        }
        if (data.refresh_token) {
          localStorage.setItem("synesis_refresh_token", data.refresh_token);
        }
        if (data.expires_in) {
          const expiresAt = Date.now() + data.expires_in * 1000;
          localStorage.setItem("synesis_token_expires_at", String(expiresAt));
        }

        const { data: userInfo } = await axios.get("/api/v1/auth/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        localStorage.setItem("synesis_user", JSON.stringify(userInfo));

        window.location.replace("/");
      } catch (err) {
        console.error("OIDC code exchange failed:", err);
        exchangeStarted.current = false;
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        sessionStorage.removeItem("synesis_pkce_verifier");
        setError("Authentication failed. Please try again.");
      }
    }

    if (oidcConfig !== null) {
      void exchangeCode();
    }
  }, [oidcConfig]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-md rounded-lg bg-white p-6 text-center shadow-xl">
          <p className="text-red-600">{error}</p>
          <a
            href="/login"
            className="mt-4 inline-block text-sm text-blue-600 hover:underline"
          >
            Back to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900">
      <div className="text-slate-400">Completing sign-in...</div>
    </div>
  );
}
