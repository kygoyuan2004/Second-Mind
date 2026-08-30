# syntax=docker/dockerfile:1.7
#
# LOCAL BUILD ONLY.
# obsidian-headless is an official open-beta package whose npm metadata is
# marked UNLICENSED. This Dockerfile is an installation recipe, not permission
# to redistribute the resulting image or the upstream package.

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG OBSIDIAN_HEADLESS_VERSION=0.0.14

LABEL org.opencontainers.image.title="VaultMind local Obsidian Sync sidecar" \
      org.opencontainers.image.description="Locally built wrapper around the official Obsidian Headless open beta" \
      org.opencontainers.image.licenses="LicenseRef-Obsidian-Headless-Upstream-Terms"

RUN npm install --global --no-audit --no-fund "obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /config /vault/.obsidian \
    && chown -R node:node /config /vault

ENV HOME=/config \
    XDG_CONFIG_HOME=/config

WORKDIR /vault
USER node
STOPSIGNAL SIGTERM

ENTRYPOINT ["ob"]
CMD ["sync", "--path", "/vault", "--continuous"]
