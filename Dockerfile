# syntax=docker/dockerfile:1.7
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache nginx ca-certificates ffmpeg \
  && mkdir -p /run/nginx /usr/share/nginx/html /app/data

# yt-dlp powers the optional media-resolve feature (/api/resolve-url) and ffmpeg
# (installed above) is what lets it mux separate video/audio tracks, which is
# how Bilibili and YouTube deliver everything now. This base image is musl
# based, so the musllinux build is the correct artefact. The download is best
# effort: an offline build still produces a working image and the feature
# simply reports itself unavailable at runtime.
ARG YTDLP_VERSION=latest
RUN if [ "$YTDLP_VERSION" = "latest" ]; then \
      YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_musllinux"; \
    else \
      YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_musllinux"; \
    fi; \
    wget -q -O /usr/local/bin/yt-dlp "$YTDLP_URL" \
      && chmod +x /usr/local/bin/yt-dlp \
    || echo "WARN: yt-dlp download failed; /api/resolve-url will report unavailable"

# YouTube has required an external JavaScript runtime for full support since
# yt-dlp 2025.11.12 — without one it silently drops the `web` player client and
# falls back to clients that cannot serve most videos. The node runtime is
# already in this image (it runs the API), so nothing new has to be installed.
ENV MEDIA_RESOLVE_JS_RUNTIME=node

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev
COPY server/ ./

WORKDIR /app
COPY index.html admin.html gallery.html webdav.html login.html preview.html block-img.html whitelist-on.html admin-imgtc.html admin-waterfall.html /usr/share/nginx/html/
COPY *.css *.js *.svg *.png *.ico /usr/share/nginx/html/
COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY docker/entrypoint.sh /usr/local/bin/yoruvault-entrypoint
RUN chmod +x /usr/local/bin/yoruvault-entrypoint

ENV NODE_ENV=production \
  PORT=8787 \
  DATA_DIR=/app/data \
  DB_PATH=/app/data/k-vault.db \
  CHUNK_DIR=/app/data/chunks

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["yoruvault-entrypoint"]
