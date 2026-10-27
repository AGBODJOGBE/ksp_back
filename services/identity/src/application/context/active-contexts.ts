import { type ActiveContext, activeContextOf } from '../../domain/context/active-context';
import { type OrganizationRepository } from '../organization/organization.ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Contexte actif du jeton de l'appelant (claim ctx), tel que les fronts l'affichent : type de
 * compte et, pour une entreprise, la raison sociale de l'organisation active (ADR-027). Le type
 * ne dépend que du jeton, comme dans cleaning et billing ; la raison sociale est lue en base.
 */
export class ActiveContexts {
  constructor(private readonly organizations: Pick<OrganizationRepository, 'findById'>) {}

  async of(ctx: string): Promise<ActiveContext> {
    const context = activeContextOf(ctx);
    if (!context.organizationId || !UUID.test(context.organizationId)) return context;
    const organization = await this.organizations.findById(context.organizationId);
    return activeContextOf(ctx, organization?.legalName ?? null);
  }
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
