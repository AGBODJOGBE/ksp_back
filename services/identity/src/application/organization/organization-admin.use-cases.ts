import { AppError, hasRole, requireRecentMfa, requireUser } from '@ksp/platform';
import {
  decide,
  needsReason,
  normalizeReason,
  type Organization,
  type OrganizationDecision,
  type OrganizationStatus,
} from '../../domain/organization/organization';
import { isUuid } from '../context/active-contexts';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { organizationErrors } from './organization-errors';
import {
  OrganizationChangedError,
  type OrganizationMemberView,
  type OrganizationPage,
  type OrganizationRepository,
} from './organization.ports';

/**
 * Validation des comptes entreprise au back-office (ADR-027). La gateway filtre déjà selon son
 * manifeste, mais identity revérifie toujours : rôle et double authentification faite pendant la
 * session du back-office (12 heures au plus).
 */
export const ORGANIZATION_REVIEWERS = ['super_admin'] as const;
export const ORGANIZATION_READERS = ['super_admin', 'support_agent'] as const;
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Membre du back-office ayant au moins un des rôles, avec double authentification ; renvoie son compte. */
export function requireStaff(allowed: readonly string[], nowMs?: number): string {
  const user = requireUser();
  if (!allowed.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return user.userId;
}

/** Organisations, les plus récentes d'abord, filtrables par état (demandes à traiter). */
export class ListOrganizationsUseCase {
  constructor(private readonly organizations: OrganizationRepository) {}

  async execute(input: {
    status: OrganizationStatus | null;
    limit: number;
    cursor: string;
  }): Promise<OrganizationPage> {
    requireStaff(ORGANIZATION_READERS);
    const limit = input.limit > 0 ? Math.min(input.limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    // Un curseur illisible repart du début plutôt que d'échouer : il ne vient que d'une page précédente.
    const cursor = input.cursor && isUuid(input.cursor) ? input.cursor : null;
    return this.organizations.list({ status: input.status }, { limit, cursor });
  }
}

/** Fiche complète d'une organisation, avec ses membres et leurs coordonnées. */
export class GetOrganizationUseCase {
  constructor(private readonly organizations: OrganizationRepository) {}

  async execute(
    organizationId: string,
  ): Promise<{ organization: Organization; members: OrganizationMemberView[] }> {
    requireStaff(ORGANIZATION_READERS);
    const organization = isUuid(organizationId) ? await this.organizations.findById(organizationId) : null;
    if (!organization) throw organizationErrors.notFound();
    return { organization, members: await this.organizations.members(organization.id) };
  }
}

/**
 * Décision d'un admin KSP : valider ou refuser une demande, suspendre ou réactiver une
 * organisation validée. Le refus et la suspension exigent un motif, communiqué au client.
 * La décision, son auteur et son motif sont écrits avec l'événement et la trace d'audit.
 */
export class DecideOrganizationUseCase {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    organizationId: string;
    decision: OrganizationDecision;
    reason?: string;
  }): Promise<Organization> {
    const actorId = requireStaff(ORGANIZATION_REVIEWERS);
    let reason: string | null = null;
    if (needsReason(input.decision)) {
      reason = normalizeReason(input.reason ?? '');
      if (!reason) {
        throw organizationErrors.invalid('reason', 'Le motif est obligatoire (500 caractères au plus).');
      }
    }

    const organization = isUuid(input.organizationId)
      ? await this.organizations.findById(input.organizationId)
      : null;
    if (!organization) throw organizationErrors.notFound();
    const to = decide(organization.status, input.decision);
    if (!to) throw organizationErrors.invalidTransition(organization.status, input.decision);

    try {
      return await this.organizations.applyDecision({
        organizationId: organization.id,
        decision: input.decision,
        from: organization.status,
        to,
        actorId,
        reason,
        auditId: this.ids.next(),
        now: this.clock.now(),
      });
    } catch (error) {
      if (!(error instanceof OrganizationChangedError)) throw error;
      // Une autre décision est passée entre-temps : on signale l'état réel.
      const current = await this.organizations.findById(organization.id);
      throw organizationErrors.invalidTransition(current?.status ?? organization.status, input.decision);
    }
  }
}
