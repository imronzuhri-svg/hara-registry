# Multi-stage build → distroless runtime.
# See services/signer/Dockerfile for the architectural rationale comment.

FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx     && corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY anchor-worker/package.json ./anchor-worker/

RUN pnpm install --filter "@hara/anchor-worker..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY anchor-worker/ ./anchor-worker/

RUN cd shared && pnpm exec tsc --build --verbose     && cd ../anchor-worker && pnpm exec tsc --build --verbose

# Rewrite shared/package.json main + exports to point at dist/ for prod
# (source points at src/.ts for tsx-in-dev compatibility).
RUN node -e "   const fs = require('fs');   const p = JSON.parse(fs.readFileSync('shared/package.json', 'utf8'));   p.main = './dist/index.js';   if (p.exports) {     for (const k of Object.keys(p.exports)) {       if (typeof p.exports[k] === 'string') {         p.exports[k] = p.exports[k].replace('./src/', './dist/').replace(/\.ts\$/, '.js');       }     }   }   fs.writeFileSync('shared/package.json', JSON.stringify(p, null, 2)); "

RUN node -e "   const fs = require('fs');   const p = JSON.parse(fs.readFileSync('anchor-worker/package.json', 'utf8'));   p.main = './dist/index.js';   fs.writeFileSync('anchor-worker/package.json', JSON.stringify(p, null, 2)); "

RUN pnpm --filter @hara/anchor-worker deploy --prod /app/deploy

FROM gcr.io/distroless/nodejs22-debian12 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/deploy/dist        ./dist
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/package.json ./package.json

EXPOSE 9102

CMD ["dist/index.js"]
