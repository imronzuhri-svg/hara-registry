FROM node:20-alpine

RUN npm install -g pnpm@9.12.0

WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY indexer/package.json ./indexer/

RUN pnpm install --filter "@hara/indexer..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY indexer/ ./indexer/

ENV SERVICE_NAME=indexer

EXPOSE 9100

WORKDIR /app/indexer
CMD ["pnpm", "start"]
