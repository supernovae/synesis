# Release Checklist

Pre-tag verification for an internet-facing, multi-tenant Synesis deployment.

## Auth and authorization

- [ ] `SYNESIS_RAG_AUTHZ_MODE` is `enforce` in chart (not `audit`)
- [ ] `SYNESIS_MCP_AUTHZ_MODE` is `enforce` in chart
- [ ] `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH` is `true`
- [ ] `SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE` is `true`
- [ ] `SYNESIS_PLANNER_TS_TRUST_MODEL_API_KEY_FOR_FORWARDED_IDENTITY` is `false`
- [ ] `SYNESIS_PAT_PEPPER` is set on planner, yarn, and admin
- [ ] `SYNESIS_REQUIRE_PAT_PEPPER` is `true` for services with DB-backed PAT validation
- [ ] `SYNESIS_YARN_ALLOW_OPAQUE_BEARER` is `false`
- [ ] `SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER` is `false`
- [ ] Credentialed CORS origins are explicit; no `*` origins on admin or MCP
- [ ] Internal service token secret synced to all namespaces
- [ ] Planner startup logs show `identity_trust_config_ok`
- [ ] `curl` without Bearer to planner returns 401
- [ ] Minting a PAT without scopes cannot invoke chat/coder endpoints

## Rate limiting

- [ ] Admin rate limiting middleware is active (`SYNESIS_ADMIN_RATE_LIMIT_MAX`)
- [ ] Planner, yarn, MCP rate limit env vars are set in chart
- [ ] Cloudflare edge rules configured per `docs/CLOUDFLARE_EDGE_HARDENING.md`
- [ ] Auth endpoints rate-limited at 20 req/min/IP

## Scaling

- [ ] Planner: `SYNESIS_PLANNER_TS_REDIS_URL` is set when replicas > 1
- [ ] Yarn: `replicas: 1` unless session affinity is configured at ingress
- [ ] Session survives planner pod kill with 2 replicas + Redis

## API validation

- [ ] Zod schemas validate `tools` and `tool_calls` with typed definitions
- [ ] `messages` array max enforced (512)
- [ ] `tools` array max enforced (128)

## OpenAI compatibility

- [ ] `npm test` passes for planner-ts and yarn-ts
- [ ] SSE conformance tests green
- [ ] Client payload conformance fixtures pass

## OpenFGA

- [ ] FGA store and model bootstrapped
- [ ] User tuples exist for all active users
- [ ] `helm template` output does not contain `audit` for authz mode vars

## Network policies

- [ ] `networkPolicies.enabled: true` in chart
- [ ] Internal services (embedder, keyword-service, NornicDB) not publicly routed
- [ ] Metrics endpoint requires auth or is blocked at edge

## Secrets

- [ ] `synesis-internal-service-auth` exists in all required namespaces
- [ ] `synesis-pat-pepper` exists in admin, planner, yarn namespaces
- [ ] `synesis-redis` URL secret exists for planner and yarn
- [ ] No `.env` files or hardcoded tokens in the repository

## Documentation

- [ ] `docs/PRODUCTION_SECURITY.md` env names match code (`SYNESIS_PLANNER_TS_*`)
- [ ] `docs/CLOUDFLARE_EDGE_HARDENING.md` three-layer rate limit section present
- [ ] `docs/SCALING.md` reviewed — pod lifecycle, session state, HPA/PDB configuration
- [ ] `docs/RELEASE_CHECKLIST.md` (this file) reviewed
