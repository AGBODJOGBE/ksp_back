# Image du service __name__. À construire depuis la racine du dépôt :
#   docker build -f services/__name__/Dockerfile -t ksp/__name__ .

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts ./contracts
COPY libs ./libs
COPY services/__name__ ./services/__name__
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ksp/__name__-service..."
RUN pnpm --filter "@ksp/__name__-service" exec prisma generate
RUN pnpm --filter "@ksp/__name__-service..." run build
RUN pnpm --filter "@ksp/__name__-service" deploy --legacy --prod --ignore-scripts /out
# Le client Prisma est généré dans le dossier du service, inclus par le déploiement.
RUN cp -r services/__name__/prisma/generated /out/prisma/generated

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# Le moteur Prisma a besoin d’OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE __GRPC_PORT__ __HTTP_PORT__
# Les migrations sont appliquées par une tâche de déploiement dédiée (prisma migrate deploy), pas au démarrage.
CMD ["node", "dist/main.js"]
