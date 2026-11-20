import { isTerminalProgram, type ProgramStatus } from '../programs/program-status';
import type { SuspensionCauseCode } from '../programs/suspension';

/**
 * Situation d'impayés d'une organisation (lot F ; CDC Nettoyage v2, R-PE-06, partie 11.3 ; RV-83,
 * RV-86, RV-87). cleaning tient son propre compte des factures mensuelles impayées de chaque
 * organisation, appris par `billing.invoice.overdue` et `billing.invoice.paid` ; les compteurs
 * publiés par billing (`holderOverdueCount`) ne sont qu'une information.
 *
 * - 1 facture impayée (seuil d'avertissement, réglable) : avertissement aux administrateurs de
 *   l'organisation et au superviseur, une fois par organisation et par nombre d'impayés.
 * - 2 factures impayées (seuil de suspension, réglable) : tous les programmes Nettoyage de
 *   l'organisation sont suspendus (cause `unpaid_invoices`) ; repasser sous le seuil lève la cause.
 */

/** Seuils des réglages (16.1) : 1 à 12, avertissement < suspension. */
export interface UnpaidThresholds {
  warning: number;
  suspension: number;
}

export const DEFAULT_UNPAID_THRESHOLDS: UnpaidThresholds = { warning: 1, suspension: 2 };

/** Champs hors bornes, vide si les seuils sont valides (règle croisée : avertissement < suspension). */
export function unpaidThresholdsProblems(thresholds: UnpaidThresholds): string[] {
  const inBounds = (value: number) => Number.isInteger(value) && value >= 1 && value <= 12;
  const problems: string[] = [];
  if (!inBounds(thresholds.warning)) problems.push('unpaidInvoicesWarning');
  if (!inBounds(thresholds.suspension)) problems.push('unpaidInvoicesSuspension');
  if (problems.length === 0 && thresholds.warning >= thresholds.suspension) {
    problems.push('unpaidInvoicesWarning');
  }
  return problems;
}

/** État d'une facture mensuelle suivie par cleaning : une facture soldée ne redevient jamais impayée. */
export type InvoiceStanding = 'overdue' | 'paid';

/**
 * RV-87 : seules les factures mensuelles d'organisation du Nettoyage sont suivies (filtre à la
 * réception de `billing.invoice.overdue` et `.paid`, versions 1 et 2).
 */
export function isTrackedInvoice(payload: {
  source: string;
  kind?: string | null;
  organizationId: string | null;
}): boolean {
  return payload.source === 'cleaning' && payload.kind === 'monthly' && payload.organizationId !== null;
}

/**
 * Nouvel état d'une facture suivie. L'ordre d'arrivée est indifférent : « soldée » (paiement, avoir
 * ou annulation, RV-87) l'emporte toujours sur « impayée ».
 */
export function nextInvoiceStanding(
  current: InvoiceStanding | null,
  event: 'overdue' | 'paid',
): InvoiceStanding {
  return current === 'paid' || event === 'paid' ? 'paid' : 'overdue';
}

/** Factures impayées de l'organisation : celles dont l'état suivi est « impayée ». */
export function countOverdue(invoices: ReadonlyArray<{ standing: InvoiceStanding }>): number {
  return invoices.filter((invoice) => invoice.standing === 'overdue').length;
}

/** Situation tenue par organisation (organization_billing_standings). */
export interface OrganizationBillingStanding {
  organizationId: string;
  overdueCount: number;
  /** Nombre d'impayés au dernier avertissement ; 0 : aucun. */
  warningLevel: number;
  version: number;
}

/** Programme de l'organisation, tel que la décision le lit. */
export interface StandingProgram {
  id: string;
  status: ProgramStatus;
  causes: ReadonlyArray<{ cause: SuspensionCauseCode }>;
}

export interface StandingDecision {
  /** Programmes non terminés auxquels ajouter la cause `unpaid_invoices`. */
  addCause: string[];
  /** Programmes dont lever la cause `unpaid_invoices`. */
  liftCause: string[];
  /** Avertissement à publier (`cleaning.organization.unpaid_warning`). */
  warn: boolean;
  /** Niveau d'avertissement après la décision. */
  warningLevel: number;
}

const hasUnpaidCause = (program: StandingProgram) =>
  program.causes.some((cause) => cause.cause === 'unpaid_invoices');

/**
 * Décision sur la situation d'une organisation après un changement de son compte d'impayés, ou à
 * la reprise d'un de ses programmes (réévaluation, R-SU-01).
 *
 * - Au seuil de suspension : la cause `unpaid_invoices` est ajoutée à tous ses programmes non
 *   terminés ; sous le seuil, elle est levée là où elle est posée.
 * - Avertissement : au seuil d'avertissement et au-delà, pour un nombre supérieur au niveau déjà
 *   averti, sauf si tous ses programmes sont suspendus après la décision (pas d'avertissement
 *   pendant une suspension, RV-83). Le niveau redescend quand le nombre baisse.
 *
 * Interprétation : une organisation sans programme en cours est avertie (elle doit de l'argent et
 * ne peut plus accepter de devis au seuil de suspension, RV-86).
 */
export function decideOrganizationStanding(input: {
  overdueCount: number;
  warningLevel: number;
  thresholds: UnpaidThresholds;
  programs: readonly StandingProgram[];
}): StandingDecision {
  const { overdueCount, thresholds } = input;
  const active = input.programs.filter((program) => !isTerminalProgram(program.status));
  const suspend = overdueCount >= thresholds.suspension;
  const addCause = suspend ? active.filter((program) => !hasUnpaidCause(program)).map((p) => p.id) : [];
  const liftCause = suspend ? [] : active.filter(hasUnpaidCause).map((program) => program.id);

  const suspendedAfter = (program: StandingProgram) => {
    if (addCause.includes(program.id)) return true;
    const remaining = program.causes.filter(
      (cause) => !(liftCause.includes(program.id) && cause.cause === 'unpaid_invoices'),
    );
    return remaining.length > 0;
  };
  const allSuspended = active.length > 0 && active.every(suspendedAfter);
  const level = Math.min(input.warningLevel, overdueCount);
  const warn = overdueCount >= thresholds.warning && overdueCount > level && !allSuspended;
  return { addCause, liftCause, warn, warningLevel: warn ? overdueCount : level };
}

/** Situation après la décision (niveau d'avertissement, compte d'impayés, version suivante). */
export function withDecision(
  standing: OrganizationBillingStanding,
  overdueCount: number,
  decision: Pick<StandingDecision, 'warningLevel'>,
): OrganizationBillingStanding {
  return {
    ...standing,
    overdueCount,
    warningLevel: decision.warningLevel,
    version: standing.version + 1,
  };
}

/** Contenu de `cleaning.organization.unpaid_warning` v1 (identifiants seulement). */
export function unpaidWarningPayload(input: {
  organizationId: string;
  overdueCount: number;
  thresholds: UnpaidThresholds;
  overdueInvoiceIds: readonly string[];
  now: Date;
}) {
  return {
    organizationId: input.organizationId,
    unpaidCount: input.overdueCount,
    warningThreshold: input.thresholds.warning,
    suspensionThreshold: input.thresholds.suspension,
    overdueInvoiceIds: [...input.overdueInvoiceIds].sort(),
    warnedAt: input.now.toISOString(),
  };
}
