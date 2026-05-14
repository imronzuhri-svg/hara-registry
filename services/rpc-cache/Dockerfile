FROM node:20-alpine
RUN npm install -g pnpm@9.12.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY rpc-cache/package.json ./rpc-cache/
RUN pnpm install --filter "@hara/rpc-cache..." --frozen-lockfile=false
COPY shared/ ./shared/
COPY rpc-cache/ ./rpc-cache/
ENV SERVICE_NAME=rpc-cache
EXPOSE 8080
WORKDIR /app/rpc-cache
CMD ["pnpm", "start"]
