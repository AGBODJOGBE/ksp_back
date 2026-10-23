/*
 * Chargement des sources TypeScript en développement (« pnpm dev » d'un service).
 * SWC sait produire les décorateurs et les métadonnées de types dont NestJS a besoin pour
 * l'injection de dépendances, ce que tsx (esbuild) ne fait pas.
 * Les alias de tsconfig.base.json (@ksp/platform, @ksp/contracts) sont relatifs à la racine du
 * dépôt : SWC les résoudrait depuis le dossier du service, d'où la base fixée ici.
 */
const path = require('node:path');
const { readDefaultTsConfig } = require('@swc-node/register/read-default-tsconfig');
const { register } = require('@swc-node/register/register');

const options = readDefaultTsConfig(path.resolve('tsconfig.json'));
options.baseUrl = path.resolve(__dirname, '..', '..');
register(options);
