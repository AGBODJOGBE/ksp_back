/**
 * Générateur de service : crée un service conforme au modèle commun en une commande.
 *
 *   pnpm new-service <nom>          ex. pnpm new-service notification
 *
 * Il crée services/<nom>, le contrat gRPC (s'il n'existe pas), déclare le package dans @ksp/contracts,
 * réserve les ports et ajoute la base locale.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const TEMPLATE = join(__dirname, 'template');
const REGISTRY = join(ROOT, 'tools', 'services.json');

interface ServiceEntry {
  grpcPort: number | null;
  httpPort: number;
  database: boolean;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  fail('Nom attendu en minuscules, avec tirets éventuels : pnpm new-service <nom>');
}
const target = join(ROOT, 'services', name);
if (existsSync(target)) fail(`services/${name} existe déjà.`);

const words = name.split('-');
const tokens: Record<string, string> = {
  __name__: name,
  __Name__: words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(''),
  __camelName__:
    words[0] +
    words
      .slice(1)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(''),
  __proto_name__: words.join('_'),
  __db_name__: words.join('_'),
};

// Ports : le suivant libre dans le registre (gRPC 500xx, HTTP interne 31xx).
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as Record<string, ServiceEntry>;
const grpcPorts = Object.values(registry).map((s) => s.grpcPort ?? 50050);
const httpPorts = Object.values(registry).map((s) => (s.httpPort >= 3100 ? s.httpPort : 3100));
tokens.__GRPC_PORT__ = String(Math.max(50050, ...grpcPorts) + 1);
tokens.__HTTP_PORT__ = String(Math.max(3100, ...httpPorts) + 1);

const replaceTokens = (text: string) =>
  Object.entries(tokens).reduce((acc, [token, value]) => acc.split(token).join(value), text);

// 1. Copie du modèle avec remplacement des jetons (contenus et noms de fichiers).
cpSync(TEMPLATE, target, { recursive: true });
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else {
      writeFileSync(path, replaceTokens(readFileSync(path, 'utf8')));
    }
    const renamed = join(dir, replaceTokens(entry));
    if (renamed !== path) renameSync(path, renamed);
  }
};
walk(target);

// 2. Contrat gRPC, s'il n'existe pas encore.
const protoDir = join(ROOT, 'contracts', 'proto', 'ksp', tokens.__proto_name__!, 'v1');
const protoFile = join(protoDir, `${tokens.__proto_name__}.proto`);
if (!existsSync(protoFile)) {
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(
    protoFile,
    `syntax = "proto3";\n\npackage ksp.${tokens.__proto_name__}.v1;\n\n` +
      `// Contrat du service ${name}. Les opérations sont ajoutées à partir de son cahier des charges.\n` +
      `service ${tokens.__Name__}Service {}\n`,
  );
}

// 3. Déclaration dans @ksp/contracts.
const protoPathFile = join(ROOT, 'libs', 'contracts', 'src', 'proto-path.ts');
const protoPathSource = readFileSync(protoPathFile, 'utf8');
if (!protoPathSource.includes(`${tokens.__camelName__}: {`)) {
  writeFileSync(
    protoPathFile,
    protoPathSource.replace(
      /( *)(\/\/ new-service:packages.*)/,
      `$1$2\n$1${tokens.__camelName__}: { package: 'ksp.${tokens.__proto_name__}.v1', file: 'ksp/${tokens.__proto_name__}/v1/${tokens.__proto_name__}.proto' },`,
    ),
  );
}
const indexFile = join(ROOT, 'libs', 'contracts', 'src', 'index.ts');
const indexSource = readFileSync(indexFile, 'utf8');
const exportLine = `export * as ${tokens.__camelName__}V1 from './generated/ksp/${tokens.__proto_name__}/v1/${tokens.__proto_name__}';`;
if (!indexSource.includes(exportLine)) {
  writeFileSync(indexFile, indexSource.replace(/(\/\/ new-service:exports.*)/, `${exportLine}\n$1`));
}

// 4. Base locale et registre des ports.
const db = tokens.__db_name__;
writeFileSync(
  join(ROOT, 'infra', 'local', 'postgres-init.sql'),
  readFileSync(join(ROOT, 'infra', 'local', 'postgres-init.sql'), 'utf8') +
    `\nCREATE USER ${db} WITH PASSWORD '${db}' CREATEDB;\nCREATE DATABASE ${db} OWNER ${db};\n`,
);
registry[name] = {
  grpcPort: Number(tokens.__GRPC_PORT__),
  httpPort: Number(tokens.__HTTP_PORT__),
  database: true,
};
writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);

console.log(
  `✓ Service ${name} créé dans services/${name} (gRPC :${tokens.__GRPC_PORT__}, HTTP :${tokens.__HTTP_PORT__})`,
);
console.log('Étapes suivantes :');
console.log('  pnpm install                 # installe les dépendances et génère le client Prisma');
console.log('  pnpm contracts:generate      # génère le code TypeScript du contrat gRPC');
console.log(`  pnpm --filter @ksp/${name}-service test`);
console.log('  docker compose down -v && pnpm infra:up   # recrée la base locale du service');
