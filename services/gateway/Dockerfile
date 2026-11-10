# Image du service gateway. À construire depuis la racine du dépôt :
#   docker build -f services/gateway/Dockerfile -t ksp/gateway .
# Pas de base de données ni de Prisma : API publique sur 3000, santé et métriques sur 3100 (interne).

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts ./contracts
COPY libs ./libs
COPY services/gateway ./services/gateway
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ksp/gateway-service..."
RUN pnpm --filter "@ksp/gateway-service..." run build
RUN pnpm --filter "@ksp/gateway-service" deploy --legacy --prod --ignore-scripts /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000 3100
CMD ["node", "dist/main.js"]
