# Multiview-Server mit MediaMTX (Netzwerk-Streams → WebRTC).
# Läuft mit network_mode: host, damit ATEM (UDP 9910), WebRTC (UDP 8189) und
# RTSP/RTMP/SRT ohne Port-Umleitung funktionieren.
FROM node:22-bookworm-slim

ARG MEDIAMTX_VERSION=v1.21.2
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# MediaMTX von GitHub, nur mit passender Prüfsumme
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) asset=linux_amd64 ;; \
    arm64) asset=linux_arm64 ;; \
    arm) asset=linux_armv7 ;; \
    *) echo "Unbekannte Architektur ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  file="mediamtx_${MEDIAMTX_VERSION}_${asset}.tar.gz"; \
  base="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}"; \
  cd /tmp; \
  curl -fsSL -o "$file" "$base/$file"; \
  curl -fsSL -o checksums.sha256 "$base/checksums.sha256"; \
  expected="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' checksums.sha256)"; \
  [ -n "$expected" ]; \
  echo "$expected  $file" | sha256sum -c -; \
  tar -xzf "$file" mediamtx; \
  install -D -m 0755 mediamtx /app/bin/mediamtx; \
  rm -f /tmp/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js day-qr.js auth-http.js auth-permissions.js device-transport.js kesher-chat.js kesher-roles.js churchtools.js access.js neighbors.js raspberry-pis.js message-links.js legacy.js legacy-runtime.js ./
COPY public ./public
COPY seed ./seed
COPY wallpapers/*.jpg ./wallpapers/

ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/data
RUN install -d -o node -g node /data
VOLUME /data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/healthz >/dev/null || exit 1

# Beim ersten Start die mitgebrachten Einstellungen übernehmen
CMD ["sh", "-c", "[ -f /data/config.json ] || cp /app/seed/config.json /data/config.json; exec node server.js"]
