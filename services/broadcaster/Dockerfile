FROM node:20-alpine

RUN npm install -g pnpm@9.12.0

WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY broadcaster/package.json ./broadcaster/

RUN pnpm install --filter "@hara/broadcaster..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY broadcaster/ ./broadcaster/

ENV SERVICE_NAME=broadcaster

WORKDIR /app/broadcaster
CMD ["pnpm", "start"]
