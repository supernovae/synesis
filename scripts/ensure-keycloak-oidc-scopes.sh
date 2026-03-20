#!/usr/bin/env bash
# Ensure the synesis realm has:
#   1. Standard OIDC client scopes (openid, profile, email) linked to both clients
#   2. Correct token/session lifetimes for good SPA UX
#
# KeycloakRealmImport only runs once; this script is an idempotent repair/update
# that can safely run on every deploy to converge realm state.
#
# Usage:
#   ./scripts/ensure-keycloak-oidc-scopes.sh
#   KEYCLOAK_PUBLIC_URL=https://synesis-auth.example.com ./scripts/ensure-keycloak-oidc-scopes.sh
#
set -euo pipefail

NS="${KEYCLOAK_NAMESPACE:-synesis-auth}"
REALM="${KEYCLOAK_REALM:-synesis}"
ADMIN_SECRET="${KEYCLOAK_ADMIN_SECRET:-synesis-keycloak-initial-admin}"

# Desired realm-level settings (seconds).
ACCESS_TOKEN_LIFESPAN="${KC_ACCESS_TOKEN_LIFESPAN:-1800}"        # 30 minutes
SSO_SESSION_IDLE="${KC_SSO_SESSION_IDLE:-14400}"                  # 4 hours
SSO_SESSION_MAX="${KC_SSO_SESSION_MAX:-43200}"                    # 12 hours

if ! command -v oc &>/dev/null; then
  echo "ERROR: oc not found" >&2
  exit 1
fi
if ! oc get secret "$ADMIN_SECRET" -n "$NS" &>/dev/null; then
  echo "WARNING: secret $ADMIN_SECRET not found in $NS — skipping OIDC scope repair" >&2
  exit 0
fi

KC_HOST="${KEYCLOAK_PUBLIC_URL:-}"
if [[ -z "$KC_HOST" ]]; then
  KC_HOST="https://$(oc get route synesis-auth -n "$NS" -o jsonpath='{.spec.host}' 2>/dev/null || true)"
fi
if [[ -z "$KC_HOST" || "$KC_HOST" == "https://" ]]; then
  echo "ERROR: could not resolve Keycloak public URL (set KEYCLOAK_PUBLIC_URL)" >&2
  exit 1
fi
BASE="${KC_HOST%/}"

KC_USER=$(oc get secret "$ADMIN_SECRET" -n "$NS" -o jsonpath='{.data.username}' | base64 -d)
KC_PASS=$(oc get secret "$ADMIN_SECRET" -n "$NS" -o jsonpath='{.data.password}' | base64 -d)

TOKEN_JSON=$(curl -sk -X POST "$BASE/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" \
  -d "username=${KC_USER}" \
  -d "password=${KC_PASS}" \
  -d "grant_type=password")

TOKEN=$(echo "$TOKEN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: failed to obtain Keycloak admin token" >&2
  echo "$TOKEN_JSON" >&2
  exit 1
fi

hdr_auth=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

# =========================================================================
# 1. Realm-level token/session lifetimes
# =========================================================================
echo "=== Updating realm '$REALM' token lifetimes ($BASE) ==="

REALM_PATCH=$(cat <<EOJSON
{
  "accessTokenLifespan": $ACCESS_TOKEN_LIFESPAN,
  "ssoSessionIdleTimeout": $SSO_SESSION_IDLE,
  "ssoSessionMaxLifespan": $SSO_SESSION_MAX
}
EOJSON
)

realm_code=$(curl -sk -o /dev/null -w "%{http_code}" -X PUT \
  "$BASE/admin/realms/$REALM" \
  "${hdr_auth[@]}" \
  -d "$REALM_PATCH")

if [[ "$realm_code" == "204" || "$realm_code" == "200" ]]; then
  echo "  accessTokenLifespan=${ACCESS_TOKEN_LIFESPAN}s  ssoSessionIdle=${SSO_SESSION_IDLE}s  ssoSessionMax=${SSO_SESSION_MAX}s"
else
  echo "WARNING: realm update returned HTTP $realm_code (lifetimes may not be updated)" >&2
fi

# =========================================================================
# 2. Client scopes (openid, profile, email)
# =========================================================================
echo "=== Ensuring OIDC client scopes on realm '$REALM' ==="

scope_id_by_name() {
  local name="$1"
  curl -sk "${hdr_auth[@]}" "$BASE/admin/realms/$REALM/client-scopes" \
    | python3 -c "import sys,json; scopes=json.load(sys.stdin); print(next((x['id'] for x in scopes if x.get('name')==sys.argv[1]), ''))" "$name"
}

create_scope_if_missing() {
  local name="$1"
  local json="$2"
  local existing
  existing="$(scope_id_by_name "$name")"
  if [[ -n "$existing" ]]; then
    echo "  client-scope '$name' already exists ($existing)" >&2
    echo "$existing"
    return 0
  fi
  local out
  out=$(curl -sk -w "\n%{http_code}" -X POST "$BASE/admin/realms/$REALM/client-scopes" \
    "${hdr_auth[@]}" -d "$json")
  local body code
  code=$(echo "$out" | tail -n1)
  body=$(echo "$out" | sed '$d')
  if [[ "$code" != "201" ]]; then
    echo "ERROR: create client-scope '$name' failed HTTP $code: $body" >&2
    exit 1
  fi
  local new_id
  new_id=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || true)
  if [[ -z "$new_id" ]]; then
    new_id="$(scope_id_by_name "$name")"
  fi
  echo "  created client-scope '$name' ($new_id)" >&2
  echo "$new_id"
}

OPENID_JSON='{"name":"openid","description":"OpenID Connect scope for subject identifier","protocol":"openid-connect","attributes":{"include.in.token.scope":"true","display.on.consent.screen":"true"},"protocolMappers":[{"name":"sub","protocol":"openid-connect","protocolMapper":"oidc-sub-mapper","consentRequired":false,"config":{"access.token.claim":"true","id.token.claim":"true"}}]}'

PROFILE_JSON='{"name":"profile","description":"OpenID Connect built-in scope: profile","protocol":"openid-connect","attributes":{"include.in.token.scope":"true","display.on.consent.screen":"true"},"protocolMappers":[{"name":"username","protocol":"openid-connect","protocolMapper":"oidc-usermodel-property-mapper","consentRequired":false,"config":{"user.attribute":"username","claim.name":"preferred_username","jsonType.label":"String","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}},{"name":"full-name","protocol":"openid-connect","protocolMapper":"oidc-full-name-mapper","consentRequired":false,"config":{"id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}}]}'

EMAIL_JSON='{"name":"email","description":"OpenID Connect built-in scope: email","protocol":"openid-connect","attributes":{"include.in.token.scope":"true","display.on.consent.screen":"true"},"protocolMappers":[{"name":"email","protocol":"openid-connect","protocolMapper":"oidc-usermodel-property-mapper","consentRequired":false,"config":{"user.attribute":"email","claim.name":"email","jsonType.label":"String","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}},{"name":"email-verified","protocol":"openid-connect","protocolMapper":"oidc-usermodel-property-mapper","consentRequired":false,"config":{"user.attribute":"emailVerified","claim.name":"email_verified","jsonType.label":"boolean","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}}]}'

OID=$(create_scope_if_missing "openid" "$OPENID_JSON")
PRF=$(create_scope_if_missing "profile" "$PROFILE_JSON")
EML=$(create_scope_if_missing "email" "$EMAIL_JSON")

# =========================================================================
# 3. Link default scopes to clients
# =========================================================================

client_uuid() {
  local cid="$1"
  curl -sk "${hdr_auth[@]}" "$BASE/admin/realms/$REALM/clients?clientId=${cid}" \
    | python3 -c "import sys,json; a=json.load(sys.stdin); print(a[0]['id'] if a else '')"
}

link_default() {
  local client_external_id="$1"
  local scope_uuid="$2"
  local scope_name="$3"
  local cuuid
  cuuid="$(client_uuid "$client_external_id")"
  if [[ -z "$cuuid" ]]; then
    echo "WARNING: client '$client_external_id' not found — skip" >&2
    return 0
  fi
  local attached
  attached=$(curl -sk "${hdr_auth[@]}" \
    "$BASE/admin/realms/$REALM/clients/${cuuid}/default-client-scopes" \
    | python3 -c "import sys,json; scopes=json.load(sys.stdin); print('yes' if any(x.get('id')==sys.argv[1] for x in scopes) else '')" "$scope_uuid")
  if [[ "$attached" == "yes" ]]; then
    echo "  $client_external_id already has default scope '$scope_name'" >&2
    return 0
  fi
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" -X PUT \
    "$BASE/admin/realms/$REALM/clients/${cuuid}/default-client-scopes/${scope_uuid}" \
    -H "Authorization: Bearer ${TOKEN}")
  if [[ "$code" == "204" || "$code" == "201" ]]; then
    echo "  linked '$scope_name' → $client_external_id" >&2
  else
    echo "WARNING: link '$scope_name' to $client_external_id returned HTTP $code" >&2
  fi
}

for CLIENT_ID in synesis-admin synesis-webui; do
  echo "--- client $CLIENT_ID ---"
  link_default "$CLIENT_ID" "$OID" "openid"
  link_default "$CLIENT_ID" "$PRF" "profile"
  link_default "$CLIENT_ID" "$EML" "email"
done

echo "=== Done. Realm token lifetimes and OIDC scopes are current. ==="
