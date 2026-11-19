# syntax=docker/dockerfile:1

FROM oven/bun:1.4.4-slim AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY scripts ./scripts

RUN bun run build

FROM oven/bun:1.4.4-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV WISP_PORT=6680

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server

USER bun
EXPOSE 3000 6680

# Default: unified app server (serves dist/ + /wisp in builtin or gateway mode).
# Override CMD to `["bun", "server/wisp-server.ts"]` to run as an isolated authenticated Wisp server.
CMD ["bun", "server/index.ts"]
