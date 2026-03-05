# Security Policy

## Supported Versions

Project Synesis is currently experimental. Security fixes are applied to the `main` branch only.

| Version | Supported |
|---------|-----------|
| main    | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Project Synesis, please **do not** open a public GitHub issue.

Instead, please report it through one of the following channels:

1. **GitHub Security Advisory** (preferred): Use the [Security Advisories](https://github.com/supernovae/synesis/security/advisories) tab to privately report the vulnerability.
2. **Email**: Contact the maintainers directly.

We will acknowledge receipt within 48 hours and provide an initial assessment within 5 business days.

## Scope

The following are in scope for security reports:

- Container image vulnerabilities in Synesis-built images
- Kubernetes manifest misconfigurations (privilege escalation, missing SCCs, etc.)
- Code execution sandbox escapes
- Secret exposure in logs, manifests, or environment variables
- Authentication/authorization bypasses in the API gateway

## Out of Scope

- Vulnerabilities in upstream dependencies that have already been reported (e.g., vLLM, LiteLLM, Milvus)
- Denial-of-service attacks against development/test environments
- Social engineering
