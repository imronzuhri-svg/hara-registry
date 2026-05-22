FROM node:22-bookworm-slim

# Patch base-image OS CVEs (libgnutls30 + friends) before installing pnpm.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*


RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx && corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY anchor-worker/package.json ./anchor-worker/

RUN pnpm install --filter "@hara/anchor-worker..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY anchor-worker/ ./anchor-worker/

ENV SERVICE_NAME=anchor-worker

EXPOSE 9102

WORKDIR /app/anchor-worker
CMD ["pnpm", "start"]
