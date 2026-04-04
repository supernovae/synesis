# Build from repository root:
#   podman build -f base/admin-mcp-ts/Dockerfile .
FROM registry.access.redhat.com/ubi10/nodejs-24:latest AS builder

USER 0
WORKDIR /opt/app-root/src

COPY base/admin-mcp-ts/package.json ./base/admin-mcp-ts/
COPY base/admin-mcp-ts/tsconfig.json ./base/admin-mcp-ts/
COPY base/admin-mcp-ts/src ./base/admin-mcp-ts/src
WORKDIR /opt/app-root/src/base/admin-mcp-ts
RUN npm install
RUN npx tsc
RUN npm prune --omit=dev

FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest

USER 1001
WORKDIR /opt/app-root/src/base/admin-mcp-ts

COPY --from=builder /opt/app-root/src/base/admin-mcp-ts/node_modules ./node_modules
COPY --from=builder /opt/app-root/src/base/admin-mcp-ts/dist ./dist
COPY --from=builder /opt/app-root/src/base/admin-mcp-ts/package.json ./

ENV NODE_ENV=production
EXPOSE 8102

CMD ["node", "dist/index.js"]
