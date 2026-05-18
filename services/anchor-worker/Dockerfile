FROM node:20-alpine

RUN npm install -g pnpm@9.12.0

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
