import { identityV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { type AgentRoles } from '../../application/agents/agent.ports';
import { callDependency } from '../grpc/dependency';

/** Seul rôle que cleaning peut attribuer et retirer (IDENTITY_ROLE_GRANT_CALLERS du contrat). */
const AGENT_ROLE = 'cleaning_agent';

/**
 * Rôle cleaning_agent chez identity (IdentityService.GrantRole et RevokeRole, R-AG-01), avec le
 * jeton de service de cleaning. Les deux appels sont idempotents chez identity (une attribution
 * active identique est rendue telle quelle, une attribution déjà retirée n'est pas retirée deux
 * fois) : une panne passagère est retentée une fois, puis rendue en IDENTITY_UNAVAILABLE. Les refus
 * d'identity (compte inconnu ou pas actif, rôle désactivé) passent tels quels.
 */
export class IdentityAgentRoles implements AgentRoles {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async grant(input: { userId: string; reason: string }): Promise<{ assignmentId: string }> {
    const response = await callDependency('identity', this.caller, 'grantRole', (metadata) =>
      this.client.grantRole(
        {
          userId: input.userId,
          roleCode: AGENT_ROLE,
          // Portée du rôle : le métier Nettoyage (identity l'applique d'après la définition du rôle).
          scopeType: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
          scopeId: 'cleaning',
          reason: input.reason,
        },
        metadata,
      ),
    );
    if (!response.assignment?.id) throw new Error('Réponse d’identity sans attribution.');
    return { assignmentId: response.assignment.id };
  }

  async revoke(input: { assignmentId: string; reason: string }): Promise<void> {
    try {
      await callDependency('identity', this.caller, 'revokeRole', (metadata) =>
        this.client.revokeRole({ assignmentId: input.assignmentId, reason: input.reason }, metadata),
      );
    } catch (error) {
      // Attribution inconnue d'identity : il n'y a plus rien à retirer.
      if (error instanceof AppError && error.code === 'IDENTITY_ROLE_ASSIGNMENT_NOT_FOUND') return;
      throw error;
    }
  }
}
