FROM node:22-bookworm-slim

# Patch base-image OS CVEs (libgnutls30 + friends) before installing pnpm.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*


RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx && corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY migrate/package.json ./migrate/

RUN pnpm install --filter "@hara/migrate..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY migrate/ ./migrate/
COPY migrations/ ./migrations/

ENV SERVICE_NAME=migrate
ENV MIGRATIONS_DIR=/app/migrations

WORKDIR /app/migrate
CMD ["pnpm", "start"]
