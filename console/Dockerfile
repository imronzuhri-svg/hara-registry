# Strata Console (web) — static SPA build served by nginx.
# /api is NOT served here; the edge Caddy routes console.<host>/api/* to the
# Console API container. This image is pure static assets.
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
