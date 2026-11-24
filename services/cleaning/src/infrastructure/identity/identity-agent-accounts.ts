import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type AgentAccount, type AgentAccounts } from '../../application/agents/agent.ports';
import { callDependency } from '../grpc/dependency';

/** État du compte tel qu'identity le nomme en base (valeurs du contrat, sans préfixe). */
function statusName(status: identityV1.UserStatus): string {
  return String(status)
    .replace(/^USER_STATUS_/, '')
    .toLowerCase();
}

/**
 * Compte KSP d'un agent créé ou invité par l'admin (IdentityService.EnsureUserByPhone et
 * FindUserByPhone, R-AG-02), avec le jeton
 * de service de cleaning ; le membre du personnel à l'origine voyage dans les métadonnées de l'appel
 * (contexte de la requête), pour la trace d'audit d'identity. L'appel est idempotent chez identity
 * (un numéro n'a qu'un compte) : une panne passagère est retentée une fois, puis rendue en
 * IDENTITY_UNAVAILABLE. Ses refus passent tels quels. Le numéro n'est jamais journalisé.
 */
export class IdentityAgentAccounts implements AgentAccounts {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async ensureByPhone(input: { phone: string; firstName: string; lastName: string }): Promise<AgentAccount> {
    const response = await callDependency('identity', this.caller, 'ensureUserByPhone', (metadata) =>
      this.client.ensureUserByPhone(
        { phoneE164: input.phone, firstName: input.firstName, lastName: input.lastName },
        metadata,
      ),
    );
    if (!response.userId) throw new Error('Réponse d’identity sans compte.');
    return { userId: response.userId, status: statusName(response.status), created: response.created };
  }

  /** IdentityService.FindUserByPhone : lecture seule, même jeton, mêmes règles de panne. */
  async findByPhone(phone: string): Promise<Pick<AgentAccount, 'userId' | 'status'> | null> {
    const response = await callDependency('identity', this.caller, 'findUserByPhone', (metadata) =>
      this.client.findUserByPhone({ phoneE164: phone }, metadata),
    );
    if (!response.found || !response.userId) return null;
    return { userId: response.userId, status: statusName(response.status) };
  }
}
