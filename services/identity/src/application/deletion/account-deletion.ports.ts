import { type DeletionObstacle, type SoleAdministeredOrganization } from '../../domain/user/account-deletion';

/**
 * Réponse des services qui implémentent ksp.common.v1.ObligationService (cleaning, billing,
 * payment…) : aucune obligation, des obligations en cours, ou au moins un service injoignable.
 */
export type ObligationCheck =
  | { status: 'clear' }
  | { status: 'blocked'; obstacles: DeletionObstacle[] }
  | { status: 'unavailable'; services: string[] };

export interface ObligationChecker {
  /** Interroge tous les services ; un service qui ne répond pas rend le contrôle « injoignable ». */
  check(userId: string): Promise<ObligationCheck>;
}

/** Écritures de la demande : compte gelé, sessions fermées, événement, en une transaction. */
export interface DeletionRequestPlan {
  userId: string;
  requestedAt: Date;
  scheduledFor: Date;
}

export interface AccountDeletionRepository {
  /** Organisations non refusées dont le compte est le seul administrateur (sans compter les comptes en cours de suppression). */
  soleAdministeredOrganizations(userId: string): Promise<SoleAdministeredOrganization[]>;
  /**
   * Compte actif → deletion_pending, toutes ses sessions révoquées, identity.user.deletion_requested
   * dans l'outbox. false si le compte n'était plus actif (rien n'est écrit).
   */
  requestDeletion(plan: DeletionRequestPlan): Promise<boolean>;
  /** deletion_pending → active, identity.user.deletion_cancelled. false si le compte n'était plus en attente. */
  cancelDeletion(userId: string, now: Date): Promise<boolean>;
  /**
   * Comptes dont la suppression est échue : jamais contrôlés, ou pas depuis `recheckBefore` ;
   * les jamais contrôlés d'abord, puis les plus anciennement contrôlés.
   */
  listDue(input: { now: Date; recheckBefore: Date; limit: number }): Promise<string[]>;
  /** Contrôle fait sans anonymiser : date, et obstacles trouvés (absents : inchangés). */
  markChecked(userId: string, at: Date, obstacles?: DeletionObstacle[]): Promise<void>;
  /**
   * Anonymise le compte s'il est toujours en attente et échu (rien sinon : false) : nom, e-mail,
   * numéros (libérés), sessions et appareils, double authentification, rôles, appartenances
   * (identity.member.removed), puis identity.user.deleted, en une transaction.
   */
  anonymize(userId: string, now: Date): Promise<boolean>;
}
