# syntax=docker/dockerfile:1.7
# The explorer as two images, built from a workspace directory (the one holding flax.yml):
#   docker build -f deploy/Dockerfile --target site .      the page, served by Caddy
#   docker build -f deploy/Dockerfile --target service .   the live service, which owns the data the page loads
# Only the dataset is copied in: flax.yml and the directories its scenarios section names (surface, features,
# personas, journeys, the board file). The packages come from the registry at the version the workspace pins.
ARG NODE_IMAGE=node:24-alpine
ARG FLAX_VERSION=latest

FROM ${NODE_IMAGE} AS install
ARG FLAX_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && pnpm init >/dev/null \
    && pnpm add "@flax/explorer@${FLAX_VERSION}" "@flax/scenarios@${FLAX_VERSION}" "@flax/cli@${FLAX_VERSION}"
COPY flax.yml ./
COPY surface surface
COPY features features
COPY personas personas
COPY journeys journeys

FROM install AS page
RUN pnpm exec flax explorer build --page-only --site /site

FROM caddy:2-alpine AS site
# Port 8080 needs no capability, and a binary with file capabilities cannot start under no-new-privileges.
RUN setcap -r /usr/bin/caddy
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=page /site /srv/site
USER 65532:65532
EXPOSE 8080

FROM install AS service
ARG GIT_SHA=unknown
ENV NODE_ENV=production EXPLORER_STATE_DIR=/srv EXPLORER_DATASET_DIR=/app EXPLORER_COMMIT=${GIT_SHA}
USER 65532:65532
EXPOSE 8081
CMD ["pnpm", "exec", "flax", "explorer", "serve"]
