/**
 * Suppression d'un compte (UC-ID-11, ADR-036) : le compte est gelé pendant le délai de suppression
 * (deletion_pending), puis anonymisé (deleted) à l'échéance si plus rien ne s'y oppose.
 */

/** Règles de la suppression, lues dans la configuration d'identity. */
export interface DeletionPolicy {
  /** Délai entre la demande et l'anonymisation : 30 jours par défaut. */
  delayDays: number;
  /** Intervalle minimal entre deux contrôles d'une suppression échue mais reportée. */
  recheckMinutes: number;
  /** Comptes traités au plus par passage de la tâche planifiée. */
  batchSize: number;
}

const DAY_MS = 86_400_000;

/** Raison lisible qui empêche la suppression (obligation d'un service ou organisation). */
export interface DeletionObstacle {
  /** Service qui l'a signalée, ou « identity » pour une organisation. */
  service: string;
  kind: string;
  reference: string;
  description: string;
}

/** Suppression demandée d'un compte. */
export interface AccountDeletion {
  requestedAt: Date;
  /** Date prévue de l'anonymisation, fixée à la demande : un changement du délai ne la déplace pas. */
  scheduledFor: Date;
  /** Obligations trouvées au dernier contrôle de l'échéance (anonymisation reportée) ; vide sinon. */
  postponedBy: DeletionObstacle[];
}

export function scheduledDeletionDate(requestedAt: Date, delayDays: number): Date {
  return new Date(requestedAt.getTime() + delayDays * DAY_MS);
}

/** Organisation dont le compte est le seul administrateur. */
export interface SoleAdministeredOrganization {
  id: string;
  legalName: string;
}

/**
 * Le dernier administrateur d'une organisation non refusée (en attente, validée ou suspendue) ne
 * peut pas supprimer son compte : l'organisation resterait sans personne pour la gérer.
 */
export function lastAdminObstacles(
  organizations: readonly SoleAdministeredOrganization[],
): DeletionObstacle[] {
  return organizations.map((organization) => ({
    service: 'identity',
    kind: 'last_org_admin',
    reference: organization.legalName,
    description: `Vous êtes le seul administrateur du compte entreprise ${organization.legalName} : nommez un autre administrateur ou contactez KSP.`,
  }));
}
