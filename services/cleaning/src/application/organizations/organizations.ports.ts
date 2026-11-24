import { type KspDecision } from '../../domain/organizations/ksp-standing';
import {
  type OrganizationStandingSettings,
  type OrganizationStandingTransaction,
} from '../../domain/organizations/ports';

/**
 * Ports de la situation des organisations (piste O ; lot F du cahier des charges) : factures
 * mensuelles impayées (R-PE-06) et décision de KSP sur l'organisation (RV-85). Ils étendent les
 * ports du domaine (`domain/organizations/ports.ts`) ; toutes les écritures passent par
 * `OrganizationUnitOfWork.run`, une transaction sous le verrou de l'organisation.
 */

/** Dernière décision de KSP appliquée à une organisation (organization_standings). */
export interface KspStanding extends KspDecision {
  organizationId: string;
}

/** Effet d'une cause posée ou levée sur un programme. */
export interface ProgramCauseEffect {
  programId: string;
  effect: 'suspended' | 'cause_added' | 'cause_lifted' | 'resumed' | 'none';
}

export interface OrganizationTransaction extends OrganizationStandingTransaction {
  /** Dernière décision de KSP appliquée ; null : organisation jamais suspendue. */
  kspStanding(organizationId: string): Promise<KspStanding | null>;
  saveKspStanding(standing: KspStanding, at: Date): Promise<void>;
  /**
   * Pose ou lève la cause `organization_suspended` sur des programmes de l'organisation, avec les
   * mêmes écritures, événements et traces que `applyProgramChanges` (acteur `system`).
   */
  applyOrganizationSuspension(input: {
    programIds: readonly string[];
    action: 'add' | 'lift';
    at: Date;
  }): Promise<ProgramCauseEffect[]>;
}

export interface OrganizationUnitOfWork {
  /**
   * Exécute `work` dans une transaction, sous le verrou de l'organisation (RV-85) : le même verrou
   * sert aux écouteurs de billing et d'identity, à SubmitRequest, PayVisitFee, AcceptQuote et à la
   * reprise d'un programme d'organisation.
   */
  run<T>(organizationId: string, work: (tx: OrganizationTransaction) => Promise<T>): Promise<T>;
  /**
   * Organisations dont la situation dépend des seuils : une facture impayée, un avertissement déjà
   * envoyé ou un programme suspendu pour impayés (réévaluation après un changement des seuils).
   */
  organizationsToReevaluate(): Promise<string[]>;
}

export type { OrganizationStandingSettings };
