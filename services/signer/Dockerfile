FROM node:22-bookworm-slim

# Patch base-image OS CVEs (libgnutls30 + friends) before installing pnpm.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*


RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx && corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

# Copy workspace manifests first for better Docker cache
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY signer/package.json ./signer/

RUN pnpm install --filter "@hara/signer..." --frozen-lockfile=false

# Copy sources
COPY shared/ ./shared/
COPY signer/ ./signer/

ENV SERVICE_NAME=signer

EXPOSE 7000

WORKDIR /app/signer
CMD ["pnpm", "start"]
