import { AppError } from '@ksp/platform';
import { type Organization } from '../../domain/organization/organization';

/** Lecture d'organisations par identifiant, pour les autres services (IdentityService). */
export interface OrganizationDirectory {
  /** Organisations trouvées, dans un ordre quelconque ; un identifiant inconnu est simplement absent. */
  findByIds(organizationIds: readonly string[]): Promise<Organization[]>;
}

/**
 * Services autorisés à lire les fiches d'organisation, et s'ils reçoivent l'e-mail de facturation.
 * Carte des services : billing copie l'en-tête des factures (raison sociale, adresse, IFU, RCCM) ;
 * notification envoie les factures à l'e-mail de facturation ; cleaning affiche la raison sociale au
 * back-office, sans l'e-mail. Tout autre appelant est refusé
 * jusqu'à son ajout ici.
 */
export const ORGANIZATION_DIRECTORY_CALLERS: Readonly<Record<string, { billingEmail: boolean }>> = {
  billing: { billingEmail: false },
  // Raison sociale affichée au back-office du Nettoyage (ADR-029).
  cleaning: { billingEmail: false },
  notification: { billingEmail: true },
};

/** Nombre maximum d'identifiants par appel à GetOrganizationsByIds. */
export const MAX_ORGANIZATION_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OrganizationDirectoryErrors = {
  callerForbidden: () =>
    AppError.forbidden(
      'IDENTITY_CALLER_FORBIDDEN',
      "Ce service n'est pas autorisé à lire les organisations.",
    ),
  organizationIdInvalid: () =>
    AppError.invalid('IDENTITY_ORGANIZATION_ID_INVALID', "Identifiant d'organisation mal formé."),
  tooManyOrganizationIds: () =>
    AppError.invalid(
      'IDENTITY_TOO_MANY_ORGANIZATION_IDS',
      `Au plus ${MAX_ORGANIZATION_IDS} identifiants d'organisation par appel.`,
    ),
};

/**
 * Lit des fiches d'organisation pour un autre service (GetOrganizationsByIds).
 *
 * - `callerService` vient du jeton de service vérifié ; null sans vérificateur (développement
 *   uniquement, le kit l'interdit en production).
 * - Tous les états sont rendus : l'appelant décide (une facture garde l'en-tête d'une organisation
 *   suspendue).
 * - Sans le droit aux coordonnées, l'e-mail de facturation est retiré.
 */
export class GetOrganizationsUseCase {
  constructor(private readonly directory: OrganizationDirectory) {}

  async many(callerService: string | null, organizationIds: readonly string[]): Promise<Organization[]> {
    let policy = { billingEmail: true };
    if (callerService !== null) {
      if (!Object.hasOwn(ORGANIZATION_DIRECTORY_CALLERS, callerService)) {
        throw OrganizationDirectoryErrors.callerForbidden();
      }
      policy = ORGANIZATION_DIRECTORY_CALLERS[callerService];
    }
    if (organizationIds.length > MAX_ORGANIZATION_IDS) {
      throw OrganizationDirectoryErrors.tooManyOrganizationIds();
    }
    const ids = [...new Set(organizationIds.map((id) => id.trim().toLowerCase()))];
    if (ids.some((id) => !UUID.test(id))) throw OrganizationDirectoryErrors.organizationIdInvalid();
    if (ids.length === 0) return [];

    const organizations = await this.directory.findByIds(ids);
    return policy.billingEmail
      ? organizations
      : organizations.map((organization) => ({ ...organization, billingEmail: null }));
  }
}
