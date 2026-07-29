# Build the Angular client, then ship a runtime image that needs no
# node_modules at all: the server imports only Node built-ins (node:sqlite,
# node:crypto, node:http) and TypeScript that Node strips types from itself.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:client

FROM node:22-slim
WORKDIR /app

# Run as a non-root user; give it the data directory.
RUN useradd --system --create-home --uid 10001 scn \
 && mkdir -p /data && chown scn:scn /data

COPY --from=build /app/dist/demo/browser ./dist/demo/browser
COPY --chown=scn:scn server ./server
COPY --chown=scn:scn src/shared ./src/shared
COPY --chown=scn:scn tools/ts-resolver.mjs ./tools/ts-resolver.mjs
COPY --chown=scn:scn package.json ./package.json

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/data/scn.sqlite \
    STATIC_DIR=/app/dist/demo/browser \
    SECURE_COOKIES=1 \
    TRUST_PROXY=1

USER scn
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "./tools/ts-resolver.mjs", "server/index.ts"]
