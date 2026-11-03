/**
 * Rejoue les événements d'outbox mis de côté d'un service (ADR-032), une fois la cause corrigée :
 *   pnpm outbox:replay <service>            tous les événements mis de côté du service
 *   pnpm outbox:replay <service> <id> …     seulement ceux-là (identifiants d'événement)
 *
 * Les événements rejoués repartent comme neufs (compteur de tentatives et premier échec remis à
 * zéro) : le relais du service les publie à son prochain passage. Logique : SqlOutboxStore.replayParked.
 *
 * Base du service : variable DATABASE_URL si elle est définie, sinon DATABASE_URL du fichier
 * services/<service>/.env. Le client Prisma du service doit être généré (pnpm prisma:generate).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { SqlOutboxStore, type TransactionalSqlClient } from '../../libs/platform/src/messaging/sql-stores';

const ROOT = join(__dirname, '..', '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PrismaLike extends TransactionalSqlClient {
  $disconnect(): Promise<void>;
}

/** Services qui ont une base (tools/services.json). */
function servicesWithDatabase(): string[] {
  const services = JSON.parse(readFileSync(join(ROOT, 'tools', 'services.json'), 'utf8')) as Record<
    string,
    { database: boolean }
  >;
  return Object.entries(services)
    .filter(([, service]) => service.database)
    .map(([name]) => name);
}

/** URL de la base : variable d'environnement, sinon fichier .env du service. */
function databaseUrl(service: string): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(ROOT, 'services', service, '.env');
  if (!existsSync(envFile)) return undefined;
  return parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined;
}

async function main(): Promise<number> {
  const [service, ...ids] = process.argv.slice(2);
  const services = servicesWithDatabase();
  if (!service || !services.includes(service)) {
    process.stderr.write(
      `Usage : pnpm outbox:replay <service> [identifiants d'événement…]\nServices : ${services.join(', ')}\n`,
    );
    return 2;
  }
  const invalid = ids.filter((id) => !UUID.test(id));
  if (invalid.length > 0) {
    process.stderr.write(`Identifiants d'événement invalides (UUID attendus) : ${invalid.join(', ')}\n`);
    return 2;
  }
  const url = databaseUrl(service);
  if (!url) {
    process.stderr.write(
      `DATABASE_URL introuvable : définir la variable, ou la renseigner dans services/${service}/.env.\n`,
    );
    return 2;
  }
  const clientPath = join(ROOT, 'services', service, 'prisma', 'generated');
  if (!existsSync(join(clientPath, 'index.js'))) {
    process.stderr.write(`Client Prisma de ${service} absent : lancer d'abord pnpm prisma:generate.\n`);
    return 2;
  }
  // Client Prisma propre au service (schema.prisma : output = ./generated).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require(clientPath) as {
    PrismaClient: new (options: { datasourceUrl: string }) => PrismaLike;
  };
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const count = await new SqlOutboxStore(prisma).replayParked(ids.length > 0 ? ids : undefined);
    const scope = ids.length > 0 ? ` (sur ${ids.length} demandé(s))` : '';
    process.stdout.write(
      `${service} : ${count} événement(s) mis de côté remis en publication${scope}. ` +
        'Le relais du service les publiera à son prochain passage.\n',
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Rejeu impossible : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
