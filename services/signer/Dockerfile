FROM node:20-alpine

RUN npm install -g pnpm@9.12.0

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
