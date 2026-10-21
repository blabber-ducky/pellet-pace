FROM node:22-alpine

# OpenSSL creates the self-signed certificate on first start.
RUN apk add --no-cache openssl

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/pellet-pace.db

# The database and certificate live in /app/data; mount a volume there to keep them.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const m=require(process.env.HTTPS==='0'?'http':'https');m.get({host:'127.0.0.1',port:process.env.PORT,path:'/api/me',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
