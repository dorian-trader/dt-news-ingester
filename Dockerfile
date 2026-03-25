# Build TypeScript and produce dist/ + schema.sql
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Runtime: native module for better-sqlite3
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm install --omit=dev \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist

# Writable DB mount (create default dir for anonymous volumes)
RUN mkdir -p /data
ENV SQLITE_PATH=/data/news.db

CMD ["node", "dist/index.js"]
