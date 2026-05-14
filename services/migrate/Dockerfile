FROM node:20-alpine

RUN npm install -g pnpm@9.12.0

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
