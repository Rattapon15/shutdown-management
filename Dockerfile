# Single image: Express API + static frontend from public/.
# Multi-stage so the runtime layer carries production dependencies only.

# ── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci needs the lockfile to match package.json exactly; --omit=dev drops
# anything only needed for local development.
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# dumb-init reaps zombies and forwards SIGTERM, which Cloud Run sends on scale-down.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules

# Application code — the frontend is static HTML in public/, served by Express,
# so backend and frontend ship as one artifact with no separate build step.
COPY package.json ./
COPY server.js db.js pool.js migrate.js schema.sql ./
COPY public ./public

# Excel uploads are parsed and deleted within the request; /tmp is the only
# writable path on Cloud Run.
ENV UPLOAD_DIR=/tmp/shutdown-uploads

# node:20-alpine ships a non-root "node" user (uid 1000).
USER node

EXPOSE 8080

# Liveness probe for runtimes that honour HEALTHCHECK (Cloud Run does not, but
# docker run / Compose / Kubernetes do).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
