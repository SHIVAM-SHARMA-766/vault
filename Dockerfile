# syntax=docker/dockerfile:1.7
#
# Vault, as one image: the API, the vault client and the public website,
# served by one Node process on port 8080. Put TLS in front of it — browsers
# refuse WebCrypto on an insecure origin, so Vault only works over https (or
# on localhost). The install profiles in deploy/ include Caddy for that.
#
#   docker build -t vault .
#   docker run -p 8080:8080 -v vault-data:/data -e VAULT_HOSTNAME=vault.example.com vault
#
# Defaults: SQLite at /data/vault.db, secrets generated into /data/secrets.env
# on first start, the website rendered under /data/site, backups (once
# BACKUP_PASSPHRASE is set) in /data/backups. Everything that must
# survive an upgrade is in /data. See docs/INSTALL.md.

ARG NODE_IMAGE=node:20.18.1-bookworm-slim

# ── 1. Build: install everything, test-free build of every workspace ────────
FROM ${NODE_IMAGE} AS build
WORKDIR /src
# npm ci installs better-sqlite3 for the workspace too. It fetches a prebuilt
# binary, and falls back to compiling when that download fails (GitHub
# release downloads do fail intermittently in CI), which needs these. The
# runtime stage below carries none of them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/crypto/package.json packages/crypto/
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build --workspace @vault/crypto \
 && npm run build --workspace @vault/core \
 && npm run build --workspace @vault/web \
 && npm run bundle --workspace @vault/api

# ── 2. The one native dependency, built for the target architecture ─────────
# better-sqlite3 is the only module the bundle leaves external. It is
# installed here, per architecture, rather than copied from the build stage,
# so an arm64 image never carries an amd64 binary.
FROM ${NODE_IMAGE} AS native
WORKDIR /deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund better-sqlite3@11.7.0

# ── 3. Runtime: no compiler, no npm cache, no source, not root ──────────────
FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="Vault" \
      org.opencontainers.image.description="Zero-knowledge password manager" \
      org.opencontainers.image.source="https://github.com/SHIVAM-SHARMA-766/vault" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production \
    VAULT_VERSION=${VERSION} \
    HOST=0.0.0.0 \
    PORT=8080 \
    SERVE_STATIC=true \
    TRUST_PROXY=true \
    DB_DRIVER=sqlite \
    DB_PATH=/data/vault.db \
    SITE_ROOT=/data/site \
    SECRETS_FILE=/data/secrets.env \
    BACKUP_DIR=/data/backups

RUN groupadd --system --gid 10001 vault \
 && useradd --system --uid 10001 --gid vault --home-dir /data --shell /usr/sbin/nologin vault \
 && mkdir -p /data && chown vault:vault /data \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*

WORKDIR /app
COPY --from=native /deps/node_modules ./node_modules
COPY --from=build /src/services/api/dist-bundle/index.mjs /src/services/api/dist-bundle/index.mjs.map ./
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/apps/site/templates ./site/templates
COPY --from=build /src/apps/site/static ./site/static
COPY --from=build /src/apps/site/content ./site/content
RUN printf '%s\n' "${VERSION}" > site/static/release.txt

USER vault
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "index.mjs"]
