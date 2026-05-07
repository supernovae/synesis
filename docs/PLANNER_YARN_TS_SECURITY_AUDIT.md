# Planner-TS and Yarn-TS Security Audit

Date: 2026-05-07

## Executive Summary

This audit covered runtime TypeScript source for `base/planner-ts/src` and `base/yarn-ts/src`. Tests and scripts were reviewed only when they informed runtime security behavior. The packages are in reasonably good shape for dependency hygiene and strict TypeScript compilation: both workspace typechecks pass, Planner-TS has no `npm audit` findings, and Yarn-TS has one moderate transitive `hono` advisory that is not high/critical.

The highest-risk issue found was in Yarn-TS bearer identity handling. Non-PAT bearer tokens were treated as opaque credentials, but if the token looked like a JWT the resolver trusted unsigned `email` or `sub` payload claims as the authorization principal passed into OpenFGA. That could allow principal spoofing in deployments that rely on bearer tokens plus OpenFGA. This is fixed: non-PAT bearer authorization identity is now always a stable hash of the token, and unsigned JWT claims are used only for optional display text.

Overall risk after remediation is medium. Remaining issues are mostly defense-in-depth gaps: a moderate transitive dependency advisory, broad TypeScript source that still relies on many assertions around external payloads, unauthenticated or token-only operational surfaces, and very large modules that make security review harder.

## Reviewed Surface and Evidence

- Runtime source: `base/planner-ts/src/**`, `base/yarn-ts/src/**`
- Excluded from primary scope: `dist`, `node_modules`, fixtures, and broad test-only cleanup.
- Typecheck:
  - `npm run typecheck --workspace synesis-planner-ts`: passed
  - `npm run typecheck --workspace synesis-yarn-ts`: passed
- Dependency audit:
  - `npm audit --workspace synesis-planner-ts --audit-level=high`: passed
  - `npm audit --workspace synesis-yarn-ts --audit-level=high`: passed
  - `npm audit --workspace synesis-planner-ts --audit-level=low --json`: 0 findings
  - `npm audit --workspace synesis-yarn-ts --audit-level=low --json`: 1 moderate transitive `hono` finding
- Semgrep:
  - TypeScript, OWASP Top Ten, and XSS rules were run against Planner/Yarn runtime source.
  - The initial scan reported one warning for `reply.send(artifact)` in Yarn-TS; this was remediated by returning the object for Fastify JSON serialization.
  - The final all-severity scan reported 0 findings.
- Targeted static review:
  - Reviewed auth, OpenFGA, PAT hashing, internal service tokens, path governance, artifact retrieval, web/search routes, JSON parsing, fetch calls, timers, and config defaults.

## Findings

### [SEVERITY: HIGH] Unsigned JWT Claims Could Spoof Yarn Authorization Identity

**Category**: Authentication and Authorization  
**File**: `base/yarn-ts/src/auth.ts`  
**Line**: 88-117  
**Status**: Fixed  

**Impact**: A caller with any syntactically valid non-PAT bearer token could embed an arbitrary unsigned JWT `email` or `sub` claim. Yarn-TS used that claim as `authUser.userId`, which is later passed to OpenFGA checks as `user:${authUser.userId}`. In an OpenFGA deployment, this could let a caller impersonate another principal if the bearer token itself was not independently verified before reaching Yarn-TS.

**Current Code**:

```typescript
const payload = this.decodeJwtPayload(token);
if (payload) {
  const fromEmail = this.safePayloadString(payload, ["email", "preferred_username", "upn"]);
  const fromSub = this.safePayloadString(payload, ["sub", "user_id", "uid"]);
  if (fromEmail) {
    const normalized = fromEmail.toLowerCase();
    return {
      userId: normalized.slice(0, 200),
      displayName: normalized,
    };
  }
  if (fromSub) {
    return {
      userId: fromSub.slice(0, 200),
      displayName: looksLikeEmail ? fromSub.toLowerCase() : undefined,
    };
  }
}
```

**Problem**: `decodeJwtPayload` only base64url-decodes the payload and does not verify signature, issuer, audience, expiry, or key material. Decoded claims are therefore attacker-controlled text and must not become authorization identity.

**Recommendation**:

```typescript
const tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
const identity = { userId: `bearer-${tokenHash}` };
```

Non-PAT bearer `userId` now always uses the token hash. Email claims may only populate `displayName`.

**References**:

- OWASP JWT Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html
- OWASP Broken Access Control: https://owasp.org/Top10/A01_2021-Broken_Access_Control/

### [SEVERITY: MEDIUM] Artifact Endpoint Triggered Direct Response Write XSS Heuristic

**Category**: Security / Injection Defense-in-Depth  
**File**: `base/yarn-ts/src/index.ts`  
**Line**: 7191-7202  
**Status**: Fixed  

**Impact**: Semgrep flagged `reply.send(artifact)` as direct response writing. The artifact is an object and Fastify serializes it as JSON, so practical XSS risk is low, but the pattern would fail a TypeScript security gate and could become risky if changed to send raw payload strings later.

**Current Code**:

```typescript
return reply.send(artifact);
```

**Problem**: Direct response writes are harder for static tools and reviewers to distinguish from raw HTML/string output.

**Recommendation**:

```typescript
return artifact;
```

Fastify now serializes the object response naturally.

**References**:

- OWASP XSS Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- Fastify reply lifecycle: https://fastify.dev/docs/latest/Reference/Reply/

### [SEVERITY: MEDIUM] Yarn-TS Has a Moderate Transitive Hono Advisory

**Category**: Dependency Security  
**File**: `base/yarn-ts/package.json`, root `package-lock.json`  
**Line**: N/A  
**Status**: Documented  

**Impact**: `npm audit --workspace synesis-yarn-ts --audit-level=low --json` reports `hono <=4.12.15` via two moderate advisories: body limit bypass for chunked/unknown-length requests and JSX tag-name injection.

**Problem**: The finding is transitive in the Yarn workspace dependency graph. The current high/critical CI policy does not fail on it, and the audited runtime source does not directly expose Hono route handling.

**Recommendation**:

```text
Track and update the dependency path that pulls hono to >=4.12.16 during the next dependency refresh.
```

**References**:

- GHSA-9vqf-7f2p-gf9v: https://github.com/advisories/GHSA-9vqf-7f2p-gf9v
- GHSA-69xw-7hcm-h432: https://github.com/advisories/GHSA-69xw-7hcm-h432

### [SEVERITY: MEDIUM] Internal Service Token Comparisons Use Plain String Equality

**Category**: Authentication and Authorization  
**File**: `base/yarn-ts/src/index.ts`, `base/planner-ts/src/app.ts`, `base/planner-ts/src/auth/resolver.ts`  
**Line**: Multiple internal-only route guards  
**Status**: Documented  

**Impact**: Internal service-token checks use direct string equality. This is acceptable for most internal HTTPS service calls, but a constant-time comparison helper would reduce timing side-channel exposure and provide one consistent guard implementation.

**Current Code**:

```typescript
return bearer === token;
```

**Problem**: Repeated direct comparisons make it easier for future code to drift and harder to audit route protection consistently.

**Recommendation**:

```typescript
crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
```

Use a shared helper that handles unequal lengths without throwing.

**References**:

- Node.js `crypto.timingSafeEqual`: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b

### [SEVERITY: MEDIUM] TypeScript Strictness Still Leaves Indexed Access and Optional Property Gaps

**Category**: Type System / Configuration  
**File**: `base/planner-ts/tsconfig.json`, `base/yarn-ts/tsconfig.json`  
**Line**: compiler options  
**Status**: Documented  

**Impact**: Both packages use `strict: true`, but neither enables `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`, and both use `skipLibCheck: true`. The codebase compensates with many non-null assertions and type assertions around external JSON-like payloads.

**Problem**: Security-sensitive code handles model payloads, tool-call arguments, auth headers, and route bodies. Stronger compiler checks would catch additional undefined and optionality bugs before runtime.

**Recommendation**:

```json
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

Adopt these behind a separate hardening branch because the change will likely require broad cleanup.

**References**:

- TypeScript `noUncheckedIndexedAccess`: https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess
- TypeScript `exactOptionalPropertyTypes`: https://www.typescriptlang.org/tsconfig/#exactOptionalPropertyTypes

### [SEVERITY: LOW] Very Large Runtime Modules Increase Review and Regression Risk

**Category**: Maintainability / Security Reviewability  
**File**: `base/yarn-ts/src/index.ts`, `base/yarn-ts/src/governance/execution-governor.ts`, `base/planner-ts/src/app.ts`  
**Line**: Whole file  
**Status**: Documented  

**Impact**: `base/yarn-ts/src/index.ts` is over 14k lines. Large route-orchestration modules increase the chance that security checks, route guards, and response handling become inconsistent.

**Problem**: The module mixes auth, routing, streaming, provider orchestration, telemetry, context admission, artifact handling, and compatibility adapters.

**Recommendation**: Split route families and shared security helpers into smaller modules as future maintainability work. Keep route-level auth helpers centralized.

## Risk Assessment

Overall risk is medium after remediation. The confirmed high-risk authorization identity issue was fixed and covered by regression tests. Dependency high/critical audit gates pass for both packages. The initial Semgrep warning was removed, and the final all-severity scan reported 0 findings.

Residual risk comes from codebase size, the amount of external JSON/model/tool payload handling, and defense-in-depth gaps that are not immediately exploitable in the reviewed configuration.

## Top Issues

1. Fixed: unsigned JWT claim trust in Yarn-TS bearer identity.
2. Fixed: Semgrep artifact response warning.
3. Documented: moderate transitive `hono` advisory in Yarn-TS.
4. Documented: direct internal service-token comparisons.
5. Documented: TypeScript strictness gaps around indexed access and exact optional properties.
6. Documented: oversized route/orchestration modules.

## Recommended Action Plan

1. Immediate: ship the Yarn bearer identity fix and CI TypeScript service security scans.
2. This sprint: refresh the dependency path that pulls `hono` to a fixed version if it remains in `npm audit`.
3. Next sprint: introduce a shared constant-time internal token comparison helper.
4. Later: pilot `noUncheckedIndexedAccess` in one package and chip away at assertion-heavy external payload boundaries.
5. Later: split `base/yarn-ts/src/index.ts` by route family and move shared auth/response helpers into focused modules.

## Metrics

- Total issues found: 6
- Critical: 0
- High: 1 fixed
- Medium: 4, with 1 fixed and 3 documented
- Low: 1 documented
- Code health score: 7/10
- Security score: 8/10 after remediation
- Maintainability score: 6/10
