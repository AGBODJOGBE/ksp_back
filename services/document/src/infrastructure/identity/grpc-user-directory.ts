import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type UserDirectory } from '../../application/ports';
import { callDependency } from '../dependencies';

/**
 * Comptes lus dans identity (GetUsersByIds, jeton de service ; document reçoit les coordonnées) :
 * nom imprimé sur le certificat, téléphone et e-mail vérifié pour envoyer les messages. Un compte
 * supprimé est introuvable. Lecture sans effet : rejouée en cas de panne passagère.
 */
export class GrpcUserDirectory implements UserDirectory {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async find(userId: string) {
    const response = await callDependency(
      this.caller,
      'identity',
      'getUsersByIds',
      (metadata) => this.client.getUsersByIds({ userIds: [userId] }, metadata),
      { idempotent: true },
    );
    const user = response.users.find((candidate) => candidate.id === userId);
    if (!user) return null;
    return {
      firstName: user.firstName,
      lastName: user.lastName,
      phoneE164: user.phoneE164 || null,
      // Seule une adresse vérifiée par code reçoit des messages.
      email: user.emailVerified ? user.email || null : null,
    };
  }
}
