import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import {
  type RecipientContact,
  type RecipientDirectory,
} from '../../application/events/event-notification.ports';

/** Limite de GetUsersByIds (contrat identity.proto). */
const BATCH = 100;

/**
 * Coordonnées des destinataires lues dans identity par gRPC (GetUsersByIds), avec le jeton de
 * service de notification (ADR-022). Lecture sans effet : l'appel peut être rejoué par l'appelant.
 */
export class IdentityRecipientDirectory implements RecipientDirectory {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async findContacts(userIds: readonly string[]): Promise<RecipientContact[]> {
    const contacts: RecipientContact[] = [];
    for (let start = 0; start < userIds.length; start += BATCH) {
      const request: identityV1.GetUsersByIdsRequest = { userIds: userIds.slice(start, start + BATCH) };
      const response = await this.caller.call(
        'getUsersByIds',
        (metadata) => this.client.getUsersByIds(request, metadata),
        { idempotent: true },
      );
      contacts.push(...response.users.map(toContact));
    }
    return contacts;
  }
}

/**
 * Convention protobuf : une chaîne vide vaut une valeur absente.
 * Règle : un e-mail ne part que vers une adresse vérifiée par code (factures, documents, avis
 * d'impayés). Une adresse non vérifiée est ignorée : le message part par les autres canaux et
 * reste visible dans l'espace KSP.
 */
function toContact(user: identityV1.User): RecipientContact {
  return {
    userId: user.id,
    firstName: user.firstName || null,
    phoneE164: user.phoneE164 || null,
    email: user.emailVerified ? user.email || null : null,
    language: user.preferredLanguage || 'fr',
  };
}
