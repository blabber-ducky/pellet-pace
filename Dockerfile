# Node 24 LTS. The app itself still runs on Node 22.13+ (package.json engines).
FROM node:24-alpine

# OpenSSL creates the self-signed certificate on first start; tzdata provides the TZ timezones.
RUN apk add --no-cache openssl tzdata

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/pellet-pace.db \
    TZ=Asia/Dubai

# The database and certificate live in /app/data; mount a volume there to keep them.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node

EXPOSE 3000

# BusyBox wget instead of starting Node every 30 s. It checks only that the app answers, so certificate
# checks are off: neither the self-signed certificate nor your own one covers 127.0.0.1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --no-check-certificate -O /dev/null "$([ "$HTTPS" = 0 ] && echo http || echo https)://127.0.0.1:${PORT}/api/me" || exit 1

CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
