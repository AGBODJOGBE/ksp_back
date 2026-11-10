# Image du service file. À construire depuis la racine du dépôt :
#   docker build -f services/file/Dockerfile -t ksp/file .

FROM node:26-alpine AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts ./contracts
COPY libs ./libs
COPY services/file ./services/file
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ksp/file-service..."
RUN pnpm --filter "@ksp/file-service" exec prisma generate
RUN pnpm --filter "@ksp/file-service..." run build
RUN pnpm --filter "@ksp/file-service" deploy --legacy --prod --ignore-scripts /out
# Le client Prisma est généré dans le dossier du service, inclus par le déploiement.
RUN cp -r services/file/prisma/generated /out/prisma/generated

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
# Le moteur Prisma a besoin d’OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 50056 3106
# Les migrations sont appliquées par une tâche de déploiement dédiée (prisma migrate deploy), pas au démarrage.
CMD ["node", "dist/main.js"]
