# Multi-stage build → distroless runtime.
#
# Stage 1 (builder): node:22-bookworm-slim with pnpm. Installs deps,
# compiles TypeScript (signer + shared via project references), then uses
# `pnpm deploy --prod` to flatten the workspace into a self-contained
# tree at /app/deploy/ with no symlinks and no devDependencies.
#
# Stage 2 (runtime): gcr.io/distroless/nodejs22-debian12 — no shell, no
# pnpm, no npm, no corepack. Only node + the deployed app. Eliminates
# the entire CVE class living in build-time tooling
# (cross-spawn / glob / picomatch / minimatch / protobufjs / etc.)
# that .trivyignore previously had to suppress.
#
# Why pnpm deploy: workspace symlinks (@hara/shared → ../shared) don't
# survive a COPY --from to a different stage; pnpm deploy flattens them
# into real files, including compiled @hara/shared.
#
# Why rewrite shared/package.json main/exports: in source they point at
# ./src/index.ts (because dev uses tsx). The runtime is plain node which
# can't import .ts — so we rewrite to ./dist/*.js before deploy.

FROM node:22-bookworm-slim AS builder

# Patch base-image OS CVEs.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Drop the bundled pnpm + corepack-cache-pnpm and install via corepack.
RUN rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# Cache-friendly: manifests first, then sources.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY signer/package.json ./signer/

RUN pnpm install --filter "@hara/signer..." --frozen-lockfile=false

COPY shared/ ./shared/
COPY signer/ ./signer/

# Compile shared first. `tsc --build` is more reliable than `tsc -b` in
# fresh CI contexts; explicit verbose to surface emit issues.
RUN cd shared && pnpm exec tsc --build --verbose && ls -la dist/ \
    && cd ../signer && pnpm exec tsc --build --verbose && ls -la dist/

# Rewrite shared's package.json so its main / exports point at compiled
# dist/ rather than .ts source. Required because the distroless runtime
# can't load TypeScript.
RUN node -e " \
  const fs = require('fs'); \
  const p = JSON.parse(fs.readFileSync('shared/package.json', 'utf8')); \
  p.main = './dist/index.js'; \
  if (p.exports) { \
    for (const k of Object.keys(p.exports)) { \
      if (typeof p.exports[k] === 'string') { \
        p.exports[k] = p.exports[k].replace('./src/', './dist/').replace(/\.ts\$/, '.js'); \
      } \
    } \
  } \
  fs.writeFileSync('shared/package.json', JSON.stringify(p, null, 2)); \
  console.log('rewrote shared/package.json exports to point at dist/'); \
"

# Same for signer's package.json — main shouldn't matter at runtime since
# we invoke dist/index.js directly via CMD, but keep it consistent.
RUN node -e " \
  const fs = require('fs'); \
  const p = JSON.parse(fs.readFileSync('signer/package.json', 'utf8')); \
  p.main = './dist/index.js'; \
  fs.writeFileSync('signer/package.json', JSON.stringify(p, null, 2)); \
"

# Flatten into a self-contained prod tree.
RUN pnpm --filter @hara/signer deploy --prod /app/deploy

# ─────────────────────────────────────────────────────────────────────────
# Runtime stage — distroless. No shell, no pnpm, no npm, no package
# manager. ENTRYPOINT is node; CMD provides the arg.
# ─────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian12 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/deploy/dist        ./dist
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/package.json ./package.json

EXPOSE 7000

CMD ["dist/index.js"]
