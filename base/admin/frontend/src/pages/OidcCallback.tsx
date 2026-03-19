import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../components/auth/AuthProvider";
import axios from "axios";

export default function OidcCallback() {
  const navigate = useNavigate();
  const { oidcConfig } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    async function exchangeCode() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");

      if (!code) {
        setError("No authorization code received");
        return;
      }

      if (!oidcConfig?.enabled || !oidcConfig.issuer || !oidcConfig.client_id) {
        setError("OIDC not configured");
        return;
      }

      const verifier = sessionStorage.getItem("synesis_pkce_verifier");
      if (!verifier) {
        setError("PKCE verifier missing — please try logging in again");
        return;
      }

      try {
        const tokenEndpoint = `${oidcConfig.issuer}/protocol/openid-connect/token`;
        const redirectUri = `${window.location.origin}/callback`;

        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: oidcConfig.client_id,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });

        const { data } = await axios.post(tokenEndpoint, body.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });

        const accessToken: string = data.access_token;

        sessionStorage.removeItem("synesis_pkce_verifier");

        const { data: userInfo } = await axios.get("/api/v1/auth/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        localStorage.setItem("synesis_token", accessToken);
        localStorage.setItem("synesis_user", JSON.stringify(userInfo));

        window.location.href = "/";
      } catch (err) {
        console.error("OIDC code exchange failed:", err);
        setError("Authentication failed. Please try again.");
        sessionStorage.removeItem("synesis_pkce_verifier");
      }
    }

    if (oidcConfig !== null) {
      exchangeCode();
    }
  }, [oidcConfig, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-sm rounded-lg bg-white p-6 text-center shadow-xl">
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
