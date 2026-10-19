import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  type ServiceClient,
  type ServiceClientRegistry,
} from '../../application/service-token/service-token.ports';

const serviceName = z.string().regex(/^[a-z][a-z0-9-]*$/, 'nom de service en minuscules');

/**
 * Format de SERVICE_CLIENTS (ADR-022) : pour chaque service, l'empreinte SHA-256 (hexadécimale) de son
 * secret et les services qu'il a le droit d'appeler. Le secret lui-même n'est connu que du service.
 *   { "gateway": { "secretSha256": "9f2c…", "audiences": ["identity", "notification"] } }
 */
const clientsSchema = z
  .record(
    z.string(),
    z.object({
      secretSha256: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue'),
      audiences: z.array(serviceName).min(1),
    }),
  )
  .superRefine((clients, ctx) => {
    for (const name of Object.keys(clients)) {
      if (!serviceName.safeParse(name).success) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'nom de service en minuscules attendu' });
      }
    }
  });

export class ServiceClientsConfigError extends Error {
  override readonly name = 'ServiceClientsConfigError';
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Registre lu dans la configuration (secret k3s) ; aucune table en base, comme les clés (ADR-020). */
export class ConfigServiceClientRegistry implements ServiceClientRegistry {
  private constructor(private readonly clients: Map<string, { hash: Buffer; audiences: string[] }>) {}

  static fromConfig(raw: string | undefined): ConfigServiceClientRegistry {
    if (!raw?.trim()) return new ConfigServiceClientRegistry(new Map());
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ServiceClientsConfigError("SERVICE_CLIENTS n'est pas un JSON valide.");
    }
    const result = clientsSchema.safeParse(parsed);
    if (!result.success) {
      throw new ServiceClientsConfigError(
        `SERVICE_CLIENTS invalide : ${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(' ; ')}`,
      );
    }
    return new ConfigServiceClientRegistry(
      new Map(
        Object.entries(result.data).map(([clientId, entry]) => [
          clientId,
          { hash: Buffer.from(entry.secretSha256, 'hex'), audiences: entry.audiences },
        ]),
      ),
    );
  }

  get size(): number {
    return this.clients.size;
  }

  authenticate(clientId: string, clientSecret: string): ServiceClient | null {
    const client = this.clients.get(clientId);
    // Empreinte calculée même pour un client inconnu : le temps de réponse ne révèle pas son existence.
    const candidate = Buffer.from(sha256Hex(clientSecret), 'hex');
    if (!client || !timingSafeEqual(candidate, client.hash)) return null;
    return { clientId, audiences: client.audiences };
  }
}
