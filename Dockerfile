# Kubernetes runs container images, so this file exists to produce one. Three stages keep it small:
# install dependencies, build, then copy only what the server needs to run.

FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# A fixed numeric user so Kubernetes can enforce "do not run as root".
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
# The home-screen icons. The standalone build does not include the public folder by itself.
COPY --from=build --chown=10001:10001 /app/public ./public
COPY --from=build --chown=10001:10001 /app/migrations ./migrations
COPY --from=build --chown=10001:10001 /app/scripts/migrate.mjs ./scripts/migrate.mjs
USER 10001
EXPOSE 3000
CMD ["node", "server.js"]
