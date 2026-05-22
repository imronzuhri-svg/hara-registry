FROM node:22-bookworm-slim

# Patch base-image OS CVEs (libgnutls30 + friends) before installing pnpm.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx && corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY rpc-cache/package.json ./rpc-cache/
RUN pnpm install --filter "@hara/rpc-cache..." --frozen-lockfile=false
COPY shared/ ./shared/
COPY rpc-cache/ ./rpc-cache/
ENV SERVICE_NAME=rpc-cache
EXPOSE 8080
WORKDIR /app/rpc-cache
CMD ["pnpm", "start"]
