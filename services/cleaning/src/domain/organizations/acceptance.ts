import type { OrganizationStanding } from '../quotes/acceptance';
import { DomainRuleError } from '../requests/errors';
import type { OrganizationRole } from '../requests/organization-access';
import { type UnpaidThresholds } from './standing';

/**
 * Organisation au seuil d'impayés (lot F ; RV-86, R-AC-02, R-PE-06). Tant que ses factures
 * impayées atteignent le seuil de suspension, l'acceptation d'un devis est refusée
 * (`CLEANING_ORGANIZATION_UNPAID_INVOICES`) ; la demande, les frais de visite et la visite restent
 * possibles, avec un avertissement non bloquant. Le compte vient de cleaning
 * (`organization_billing_standings.overdue_count`, RV-83), lu sous le verrou de l'organisation.
 */
export type RequestWarning = 'organization_unpaid_invoices';

/** L'organisation atteint-elle le seuil de suspension ? */
export function atSuspensionThreshold(overdueCount: number, thresholds: UnpaidThresholds): boolean {
  return overdueCount >= thresholds.suspension;
}

/** Avertissements non bloquants d'une demande (Request.warnings), calculés à la lecture. */
export function requestWarnings(
  organization: { overdueCount: number } | null,
  thresholds: UnpaidThresholds,
): RequestWarning[] {
  return organization && atSuspensionThreshold(organization.overdueCount, thresholds)
    ? ['organization_unpaid_invoices']
    : [];
}

/**
 * Refus de l'acceptation au seuil, avec les mêmes détails que `quotes/acceptance.ts` (contrôle
 * possible avant de construire le programme, ou hors du parcours d'acceptation).
 */
export function assertNotAtUnpaidThreshold(overdueCount: number, thresholds: UnpaidThresholds): void {
  if (atSuspensionThreshold(overdueCount, thresholds)) {
    throw new DomainRuleError('CLEANING_ORGANIZATION_UNPAID_INVOICES', {
      unpaidCount: overdueCount,
      threshold: thresholds.suspension,
    });
  }
}

/**
 * Situation de l'organisation passée à `acceptQuote` (quotes/acceptance.ts) : le compte d'impayés
 * de cleaning et le seuil de suspension des réglages.
 */
export function acceptanceStanding(input: {
  role: OrganizationRole;
  suspended: boolean;
  overdueCount: number;
  thresholds: UnpaidThresholds;
}): OrganizationStanding {
  return {
    role: input.role,
    suspended: input.suspended,
    unpaidInvoices: input.overdueCount,
    unpaidInvoicesSuspension: input.thresholds.suspension,
  };
}
