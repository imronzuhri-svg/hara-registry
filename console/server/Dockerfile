# Strata Console API — read-only aggregator.
# Small service; runs via tsx (no separate build step). esbuild's platform
# binary is installed because package.json pins it in pnpm.onlyBuiltDependencies.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# --prod keeps tsx (a runtime dep here) but drops typescript/@types.
RUN pnpm install --prod --frozen-lockfile=false

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8910
EXPOSE 8910

CMD ["node_modules/.bin/tsx", "src/index.ts"]
