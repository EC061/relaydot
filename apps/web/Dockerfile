FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
    && apt-get install --no-install-recommends --yes libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.13.1 --activate

FROM base AS dependencies

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# Honker ships its N-API bindings as platform-specific optional dependencies.
# Force pnpm to materialize the target binding in clean BuildKit environments.
RUN pnpm install --frozen-lockfile --force

FROM dependencies AS builder

COPY . .

RUN pnpm --filter @relaydot/controller build

FROM base AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV RELAYDOT_DATABASE_PATH=/app/data/relaydot.db

WORKDIR /app

COPY --from=builder --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "apps/web/server.js"]
