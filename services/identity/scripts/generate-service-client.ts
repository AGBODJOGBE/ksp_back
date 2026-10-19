/**
 * Crée les identifiants d'un service auprès d'identity (ADR-022).
 *   pnpm --filter @ksp/identity-service keys:service-client gateway identity notification
 * Affiche :
 * - le secret, à placer dans le coffre du service lui-même (SERVICE_CLIENT_SECRET) ;
 * - l'entrée à ajouter à SERVICE_CLIENTS d'identity (empreinte seulement, jamais le secret).
 */
import { createHash, randomBytes } from 'node:crypto';

const [clientId, ...audiences] = process.argv.slice(2);
if (!clientId || audiences.length === 0) {
  process.stderr.write('Usage : keys:service-client <service> <service appelé> [<service appelé>…]\n');
  process.exit(1);
}
const secret = randomBytes(32).toString('base64url');
const secretSha256 = createHash('sha256').update(secret).digest('hex');
process.stdout.write(`SERVICE_CLIENT_SECRET de ${clientId} :\n${secret}\n\n`);
process.stdout.write(
  `Entrée SERVICE_CLIENTS d'identity :\n${JSON.stringify({ [clientId]: { secretSha256, audiences } })}\n`,
);
