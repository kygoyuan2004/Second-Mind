# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --omit=dev --ignore-scripts --no-audit --no-fund; \
    fi

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Second-Mind" \
      org.opencontainers.image.description="Self-hosted, source-grounded Obsidian knowledge assistant"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    PUBLIC_DIR=/app/public \
    VAULT_PATH=/vault

WORKDIR /app

RUN mkdir -p /app/data /vault && chown -R node:node /app /vault

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
# Copy only runtime code and browser assets. In particular, the optional
# Obsidian Headless build recipe and every local deployment file stay outside
# the main application image.
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/sync-vendor-assets.mjs ./scripts/sync-vendor-assets.mjs

# Static browser dependencies are generated during the image build. Runtime can
# therefore use a read-only root filesystem.
RUN node scripts/sync-vendor-assets.mjs

USER node
EXPOSE 8787
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=2m --retries=10 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8787}/health/ready`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "src/server.mjs"]
