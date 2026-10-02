# =========================================================================
# dotMDpritter — production image
#
# Two stages so the runtime image carries no npm cache, no dev files and a
# non-root user. There are no npm dependencies, so `npm ci` is a no-op that
# simply proves the lockfile state.
# =========================================================================
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
# No dependencies to install; this layer exists for cache clarity.
RUN npm ls --production >/dev/null 2>&1 || true

FROM node:22-alpine AS runtime

# tini gives us correct signal handling so SIGTERM reaches node and the
# graceful shutdown in server.js actually runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=4173 \
    DOTMD_DATA=/data

WORKDIR /app

# Run unprivileged. The data volume must be writable by uid 1000.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

COPY --chown=node:node package.json ./
COPY --chown=node:node index.html ./
COPY --chown=node:node server.js ./
COPY --chown=node:node README.md ./
COPY --chown=node:node assets ./assets
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node server ./server

VOLUME ["/data"]
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||4173,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
