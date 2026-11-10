/**
 * Rejoue les messages en file d'erreurs (.dlq) des consommateurs d'un service, une fois la cause
 * corrigée (ADR-032) :
 *   pnpm dlq:replay <service>                 toutes les files d'erreurs du service
 *   pnpm dlq:replay <service> <événement> …   seulement celles de ces événements
 *
 * Les messages repartent dans la file principale comme neufs (compteur de tentatives remis à zéro) ;
 * seuls ceux présents au lancement sont repris. Logique : replayDeadLetters (libs/platform).
 *
 * Broker : variable RABBITMQ_URL si elle est définie, sinon RABBITMQ_URL du fichier services/<service>/.env.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { RabbitMqConnection } from '../../libs/platform/src/messaging/rabbitmq/connection';
import { replayDeadLetters } from '../../libs/platform/src/messaging/rabbitmq/dead-letters';
import { consumerQueues } from '../../libs/platform/src/messaging/rabbitmq/topology';

const ROOT = join(__dirname, '..', '..');

function services(): string[] {
  return Object.keys(JSON.parse(readFileSync(join(ROOT, 'tools', 'services.json'), 'utf8')) as object);
}

/** Schéma d'un événement : contracts/events/<domaine>/<type>.v<version>.schema.json. */
const SCHEMA_FILE = /^(.+)\.v\d+\.schema\.json$/;

/** Types d'événements connus, toutes versions confondues (un type par schéma, sans doublon). */
function eventTypes(): string[] {
  const root = join(ROOT, 'contracts', 'events');
  const types = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((domain) =>
      readdirSync(join(root, domain.name)).flatMap((file) => SCHEMA_FILE.exec(file)?.[1] ?? []),
    );
  return [...new Set(types)];
}

function rabbitMqUrl(service: string): string | undefined {
  if (process.env.RABBITMQ_URL) return process.env.RABBITMQ_URL;
  const envFile = join(ROOT, 'services', service, '.env');
  if (!existsSync(envFile)) return undefined;
  return parseEnv(readFileSync(envFile, 'utf8')).RABBITMQ_URL || undefined;
}

/** Une file absente (le service ne consomme pas cet événement) ferme le canal : vérifiée sur un canal à part. */
async function queueExists(connection: RabbitMqConnection, queue: string): Promise<boolean> {
  const channel = await connection.consumerChannel(1);
  channel.on('error', () => undefined);
  try {
    await channel.checkQueue(queue);
    await channel.close();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const [service, ...requested] = process.argv.slice(2);
  const known = eventTypes();
  if (!service || !services().includes(service)) {
    process.stderr.write(
      `Usage : pnpm dlq:replay <service> [types d'événement…]\nServices : ${services().join(', ')}\n`,
    );
    return 2;
  }
  const unknown = requested.filter((type) => !known.includes(type));
  if (unknown.length > 0) {
    process.stderr.write(`Événements inconnus : ${unknown.join(', ')}\n`);
    return 2;
  }
  const url = rabbitMqUrl(service);
  if (!url) {
    process.stderr.write(
      `RABBITMQ_URL introuvable : définir la variable, ou la renseigner dans services/${service}/.env.\n`,
    );
    return 2;
  }
  const connection = new RabbitMqConnection(url);
  try {
    let total = 0;
    for (const type of requested.length > 0 ? requested : known) {
      const queues = consumerQueues(service, type);
      if (!(await queueExists(connection, queues.dlq))) continue;
      const channel = await connection.consumerChannel(1);
      try {
        const count = await replayDeadLetters(channel, queues);
        if (count > 0)
          process.stdout.write(`${queues.dlq} : ${count} message(s) remis dans ${queues.main}\n`);
        total += count;
      } finally {
        await channel.close();
      }
    }
    process.stdout.write(`${service} : ${total} message(s) rejoué(s).\n`);
    return 0;
  } finally {
    await connection.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Connexion refusée : AggregateError sans message, le code (ECONNREFUSED) est plus parlant.
    const detail =
      error instanceof Error
        ? error.message || (error as { code?: string }).code || error.name
        : String(error);
    process.stderr.write(`Rejeu impossible : ${detail}\n`);
    process.exitCode = 1;
  },
);
