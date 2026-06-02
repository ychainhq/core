FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# Migrations must be present at runtime path
COPY src/db/migrations/ ./dist/db/migrations/

# Non-root user for security
USER node

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "dist/main.js"]
