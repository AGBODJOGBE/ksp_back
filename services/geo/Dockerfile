# Image du service geo. À construire depuis la racine du dépôt :
#   docker build -f services/geo/Dockerfile -t ksp/geo .
# Pas de base de données ni de Prisma (ADR-045).

FROM node:26-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts ./contracts
COPY libs ./libs
COPY services/geo ./services/geo
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ksp/geo-service..."
RUN pnpm --filter "@ksp/geo-service..." run build
RUN pnpm --filter "@ksp/geo-service" deploy --legacy --prod --ignore-scripts /out

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 50059 3109
CMD ["node", "dist/main.js"]
