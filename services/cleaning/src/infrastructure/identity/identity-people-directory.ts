import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type PeopleDirectory } from '../../application/ports';

/** Limite de GetUsersByIds et GetOrganizationsByIds (contrat identity.proto). */
const BATCH = 100;

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += BATCH) result.push(values.slice(start, start + BATCH));
  return result;
}

/** « Prénom Nom », sans espace en trop ; vide si le profil n'est pas complété. */
export function displayName(user: Pick<identityV1.User, 'firstName' | 'lastName'>): string {
  return [user.firstName, user.lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Noms affichés au back-office, lus dans identity par gRPC avec le jeton de service de cleaning
 * (ADR-022, ADR-029) : délai, nouvelle tentative et coupe-circuit du GrpcCaller. identity ne rend
 * à cleaning ni le téléphone ni l'e-mail. Lecture au mieux : en cas d'échec (identity indisponible,
 * appel refusé), les noms manquent et la réponse du back-office part quand même ; l'échec est
 * journalisé, sans aucun identifiant de personne.
 */
export class IdentityPeopleDirectory implements PeopleDirectory {
  private readonly logger = new Logger('IdentityPeopleDirectory');

  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async userNames(userIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      for (const batch of chunks(userIds)) {
        const response = await this.caller.call(
          'getUsersByIds',
          (metadata) => this.client.getUsersByIds({ userIds: batch }, metadata),
          { idempotent: true },
        );
        for (const user of response.users) {
          const name = displayName(user);
          if (name) names.set(user.id, name);
        }
      }
    } catch (error) {
      this.warn('comptes', error);
    }
    return names;
  }

  async organizationNames(organizationIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      for (const batch of chunks(organizationIds)) {
        const response = await this.caller.call(
          'getOrganizationsByIds',
          (metadata) => this.client.getOrganizationsByIds({ organizationIds: batch }, metadata),
          { idempotent: true },
        );
        for (const organization of response.organizations) {
          if (organization.legalName) names.set(organization.id, organization.legalName);
        }
      }
    } catch (error) {
      this.warn('organisations', error);
    }
    return names;
  }

  private warn(what: string, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    this.logger.warn(
      `Noms des ${what} indisponibles (identity) : ${typeof code === 'string' ? code : 'erreur'}.`,
    );
  }
}
