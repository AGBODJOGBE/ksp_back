import { AppError } from '@ksp/platform';
import { type ActiveContext, PERSONAL_CONTEXT } from '../../domain/context/active-context';
import { canBeActiveContext } from '../../domain/organization/organization';
import { sessionCategory } from '../../domain/session/session-policy';
import { isUuid } from '../context/active-contexts';
import { organizationErrors } from '../organization/organization-errors';
import { type OrganizationRepository } from '../organization/organization.ports';
import { CUSTOMER_ROLE, organizationRoleClaims } from '../role/role-claims';
import { type Clock } from '../shared/system.ports';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { type SessionStore } from './session-store.ports';

export interface SwitchedContext {
  accessToken: string;
  accessTokenExpiresAt: Date;
  activeContext: ActiveContext;
}

/**
 * UC-ID-15 : changer le contexte actif de la session (ADR-027). Passer à une organisation exige
 * qu'elle soit validée et que l'utilisateur en soit membre ; null ramène au contexte personnel.
 * Le contexte est enregistré dans la session (active_org_id), que le renouvellement relit, et un
 * nouveau jeton d'accès est émis avec ctx = l'organisation et le rôle du membre (portée org).
 * Le back-office reste dans le contexte personnel : ses rôles ne se mélangent pas à ceux d'un client.
 */
export class SwitchContextUseCase {
  constructor(
    private readonly sessions: SessionStore,
    private readonly organizations: Pick<OrganizationRepository, 'membership'>,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    userId: string;
    sessionId: string;
    /** Null : retour au contexte personnel. */
    organizationId: string | null;
  }): Promise<SwitchedContext> {
    const now = this.clock.now();
    const session = isUuid(input.sessionId) ? await this.sessions.findSession(input.sessionId) : null;
    if (!session || session.userId !== input.userId || session.revokedAt || session.expiresAt <= now) {
      throw organizationErrors.sessionRevoked();
    }
    if (session.account.status === 'suspended') {
      throw AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.');
    }
    if (sessionCategory(session.clientKind) !== 'customer') throw organizationErrors.contextForbidden();

    let organization: { id: string; legalName: string } | null = null;
    let roles = [CUSTOMER_ROLE];
    if (input.organizationId !== null) {
      const membership = isUuid(input.organizationId)
        ? await this.organizations.membership(input.userId, input.organizationId)
        : null;
      if (!membership) throw organizationErrors.notFound();
      const { status } = membership.organization;
      if (!canBeActiveContext(status)) throw organizationErrors.notActive(status);
      organization = membership.organization;
      roles = organizationRoleClaims(organization.id, membership.role);
    }

    const saved = await this.sessions.setActiveOrganization(
      session.id,
      input.userId,
      organization?.id ?? null,
    );
    if (!saved) throw organizationErrors.sessionRevoked();

    const access = await this.accessTokens.issue({
      userId: input.userId,
      sessionId: session.id,
      clientId: session.clientKind,
      activeContext: organization?.id ?? PERSONAL_CONTEXT,
      organizationName: organization?.legalName ?? null,
      roles,
      mfa: false,
      // Un changement de contexte n'est pas une authentification : heure de la connexion.
      authTime: session.createdAt,
      amr: ['otp'],
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      activeContext: access.activeContext,
    };
  }
}
