ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-node-workspace:latest
FROM ${BASE_IMAGE} AS builder

USER 0
WORKDIR /opt/app-root/src

COPY base/synesis-mcp/tsconfig.json base/synesis-mcp/
COPY base/synesis-mcp/src base/synesis-mcp/src
RUN npm run build --workspace=base/synesis-mcp
RUN npm prune --omit=dev

FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest

USER 1001
WORKDIR /opt/app-root/src

COPY --from=builder /opt/app-root/src/node_modules ./node_modules
COPY --from=builder /opt/app-root/src/packages ./packages
COPY --from=builder /opt/app-root/src/base/synesis-mcp/node_modules base/synesis-mcp/node_modules
COPY --from=builder /opt/app-root/src/base/synesis-mcp/package.json base/synesis-mcp/package.json
COPY --from=builder /opt/app-root/src/base/synesis-mcp/dist base/synesis-mcp/dist
RUN node -e "const { createRequire } = require('node:module'); createRequire(process.cwd() + '/base/synesis-mcp/dist/index.js').resolve('@fastify/rate-limit')"

ENV NODE_ENV=production
EXPOSE 8100

CMD ["node", "--enable-source-maps", "base/synesis-mcp/dist/index.js"]
