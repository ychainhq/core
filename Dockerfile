FROM node:20-alpine AS builder
WORKDIR /app

# python3 + make + g++ are required by better-sqlite3 (node-gyp native build).
# Alpine has no prebuilt binary for better-sqlite3 on arm64, so it must compile from source.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Remove devDependencies in-place. The native .node binary is already compiled;
# npm prune keeps it without triggering a rebuild (unlike npm ci --omit=dev).
RUN npm prune --omit=dev

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy pre-built (and pruned) node_modules from builder — no native rebuild needed.
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Migrations must be present at runtime path
COPY src/db/migrations/ ./dist/db/migrations/

# Non-root user for security
USER node

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "dist/main.js"]
