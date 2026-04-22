import { useEffect, useRef, useState } from "react";
import { useAuth } from "../components/auth/useAuth";
import axios from "axios";
import { USER_KEY, persistTokens } from "../utils/oidcSession";

const SUPPRESS_AUTO_KEY = "synesis_oidc_suppress_auto";
const OIDC_STATE_KEY = "synesis_oidc_state";

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
      const returnedState = params.get("state");

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
      const expectedState = sessionStorage.getItem(OIDC_STATE_KEY);
      if (!verifier) {
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        setError("PKCE verifier missing — please try logging in again");
        return;
      }
      if (!expectedState || !returnedState || expectedState !== returnedState) {
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        sessionStorage.removeItem("synesis_pkce_verifier");
        sessionStorage.removeItem(OIDC_STATE_KEY);
        setError("Invalid OIDC state — please try logging in again");
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
        sessionStorage.removeItem(OIDC_STATE_KEY);
        sessionStorage.removeItem(SUPPRESS_AUTO_KEY);

        // Persist tokens.
        persistTokens(accessToken, data.refresh_token, data.expires_in, data.id_token);

        const { data: userInfo } = await axios.get("/api/v1/auth/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        localStorage.setItem(USER_KEY, JSON.stringify(userInfo));

        const returnTo = sessionStorage.getItem("synesis_return_to") || "/";
        sessionStorage.removeItem("synesis_return_to");
        window.location.replace(returnTo);
      } catch (err) {
        console.error("OIDC code exchange failed:", err);
        exchangeStarted.current = false;
        sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
        sessionStorage.removeItem("synesis_pkce_verifier");
        sessionStorage.removeItem(OIDC_STATE_KEY);
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
