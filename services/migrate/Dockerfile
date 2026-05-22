# Multi-stage build → distroless runtime.
# See services/signer/Dockerfile for the architectural rationale comment.

FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx     && corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY migrate/package.json ./migrate/

# migrate consumes sibling directory services/migrations/*.sql via env.
# pnpm deploy doesn't bring that along (not part of @hara/migrate). Copy
# explicitly in the builder + ship to runtime below.
COPY migrations/ ./migrations/

RUN pnpm install --filter "@hara/migrate..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY migrate/ ./migrate/

RUN cd shared && pnpm exec tsc --build --verbose     && cd ../migrate && pnpm exec tsc --build --verbose

# Rewrite shared/package.json main + exports to point at dist/ for prod
# (source points at src/.ts for tsx-in-dev compatibility).
RUN node -e "   const fs = require('fs');   const p = JSON.parse(fs.readFileSync('shared/package.json', 'utf8'));   p.main = './dist/index.js';   if (p.exports) {     for (const k of Object.keys(p.exports)) {       if (typeof p.exports[k] === 'string') {         p.exports[k] = p.exports[k].replace('./src/', './dist/').replace(/\.ts\$/, '.js');       }     }   }   fs.writeFileSync('shared/package.json', JSON.stringify(p, null, 2)); "

RUN node -e "   const fs = require('fs');   const p = JSON.parse(fs.readFileSync('migrate/package.json', 'utf8'));   p.main = './dist/index.js';   fs.writeFileSync('migrate/package.json', JSON.stringify(p, null, 2)); "

RUN pnpm --filter @hara/migrate deploy --prod /app/deploy

FROM gcr.io/distroless/nodejs22-debian12 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/deploy/dist        ./dist
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/package.json ./package.json
COPY --from=builder /app/migrations          /app/migrations
ENV MIGRATIONS_DIR=/app/migrations

CMD ["dist/index.js"]
