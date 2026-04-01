FROM registry.access.redhat.com/ubi9/nodejs-22:latest AS builder

USER 0
WORKDIR /opt/app-root/src

COPY package.json package-lock.json ./
# Build requires TypeScript from devDependencies; prune after compile.
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc
RUN npm prune --omit=dev

FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:latest

USER 1001
WORKDIR /opt/app-root/src

COPY --from=builder /opt/app-root/src/node_modules ./node_modules
COPY --from=builder /opt/app-root/src/dist ./dist
COPY --from=builder /opt/app-root/src/package.json ./

ENV NODE_ENV=production
EXPOSE 8100

CMD ["node", "dist/index.js"]
