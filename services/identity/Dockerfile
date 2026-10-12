# Image du service identity. À construire depuis la racine du dépôt :
#   docker build -f services/identity/Dockerfile -t ksp/identity .

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts ./contracts
COPY libs ./libs
COPY services/identity ./services/identity
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ksp/identity-service..."
RUN pnpm --filter "@ksp/identity-service" exec prisma generate
RUN pnpm --filter "@ksp/identity-service..." run build
RUN pnpm --filter "@ksp/identity-service" deploy --legacy --prod --ignore-scripts /out
# Le client Prisma est généré dans le dossier du service, inclus par le déploiement.
RUN cp -r services/identity/prisma/generated /out/prisma/generated

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# Le moteur Prisma a besoin d’OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 50051 3101
# Les migrations sont appliquées par une tâche de déploiement dédiée (prisma migrate deploy), pas au démarrage.
CMD ["node", "dist/main.js"]
