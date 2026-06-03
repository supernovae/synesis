ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-node-workspace:latest
FROM ${BASE_IMAGE} AS builder

USER 0
WORKDIR /opt/app-root/src

COPY base/admin-mcp-ts/tsconfig.json base/admin-mcp-ts/
COPY base/admin-mcp-ts/src base/admin-mcp-ts/src
RUN npm run build --workspace=base/admin-mcp-ts
RUN npm prune --omit=dev

FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest

USER 1001
WORKDIR /opt/app-root/src

COPY --from=builder /opt/app-root/src/node_modules ./node_modules
COPY --from=builder /opt/app-root/src/packages ./packages
COPY --from=builder /opt/app-root/src/base/admin-mcp-ts/package.json base/admin-mcp-ts/package.json
COPY --from=builder /opt/app-root/src/base/admin-mcp-ts/dist base/admin-mcp-ts/dist

ENV NODE_ENV=production
EXPOSE 8102

CMD ["node", "--enable-source-maps", "base/admin-mcp-ts/dist/index.js"]
