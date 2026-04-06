# Build from repository root:
#   podman build -f base/mcp-ts/Dockerfile .
FROM registry.access.redhat.com/ubi10/nodejs-24:latest AS builder

USER 0
WORKDIR /opt/app-root/src

COPY packages/synesis-mcp-tools/package.json packages/synesis-mcp-tools/tsconfig.json ./packages/synesis-mcp-tools/
COPY packages/synesis-mcp-tools/src ./packages/synesis-mcp-tools/src
RUN cd packages/synesis-mcp-tools && npm install && npm run build

COPY base/mcp-ts/package.json base/mcp-ts/package-lock.json ./base/mcp-ts/
COPY base/mcp-ts/tsconfig.json ./base/mcp-ts/
COPY base/mcp-ts/src ./base/mcp-ts/src
WORKDIR /opt/app-root/src/base/mcp-ts
# Lockfile is maintained for this image (not the repo-root workspace lock). Refresh: `npm install --workspaces=false` here.
RUN npm ci
RUN npx tsc
RUN npm prune --omit=dev

FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest

USER 1001
WORKDIR /opt/app-root/src/base/mcp-ts

COPY --from=builder /opt/app-root/src/packages /opt/app-root/src/packages
COPY --from=builder /opt/app-root/src/base/mcp-ts/node_modules ./node_modules
COPY --from=builder /opt/app-root/src/base/mcp-ts/dist ./dist
COPY --from=builder /opt/app-root/src/base/mcp-ts/package.json ./

ENV NODE_ENV=production
EXPOSE 8100

CMD ["node", "dist/index.js"]
