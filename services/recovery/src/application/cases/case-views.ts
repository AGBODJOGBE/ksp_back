import { type PlanScale } from '../../domain/payment-plan';
import { type Directory, type FullSettings, type Holder, type HolidayStore } from '../ports';
import { amountDue, type DeadlineKind, effectiveScale, nextDeadline, upcomingHolidays } from './case-rules';
import {
  type CaseQueries,
  type CaseSummaryRecord,
  type RecoveryCaseRecord,
  type StageTransitionData,
} from './ports';

/**
 * Vues présentées par l'interface : le dossier, ses montants (R-SD-08), son échéance suivante, son
 * barème et les noms affichés du créancier et du chargé (identity). Un nom indisponible (identity
 * injoignable) reste vide : la fiche s'affiche quand même.
 */
export interface CaseAmountsView {
  principal: number;
  interests: number;
  costs: number;
  paid: number;
  waived: number;
  due: number;
  overpaid: number;
}

export interface CaseView {
  record: RecoveryCaseRecord;
  creditorName: string;
  agentName: string;
  amounts: CaseAmountsView;
  planScale: PlanScale;
  nextDeadline: { kind: DeadlineKind; dueAt: Date } | null;
  stageHistory: StageTransitionData[];
}

export interface CaseSummaryView {
  summary: CaseSummaryRecord;
  creditorName: string;
  agentName: string;
  due: number;
  nextDeadline: { kind: DeadlineKind; dueAt: Date } | null;
}

export interface ViewDeps {
  caseQueries: CaseQueries;
  directory: Directory;
  holidays: HolidayStore;
}

/** Noms affichés des comptes et des organisations, sans bloquer si identity ne répond pas. */
export async function displayNames(
  directory: Directory,
  holders: readonly Holder[],
  userIds: readonly string[],
): Promise<{ holder: (holder: Holder) => string; user: (userId: string | null) => string }> {
  const users = new Map<string, string>();
  const organizations = new Map<string, string>();
  const people = [...new Set([...holders.filter((h) => h.type === 'user').map((h) => h.id), ...userIds])];
  const orgs = [...new Set(holders.filter((h) => h.type === 'organization').map((h) => h.id))];
  try {
    if (people.length > 0) {
      for (const person of await directory.usersByIds(people)) users.set(person.userId, person.displayName);
    }
    if (orgs.length > 0) {
      for (const org of await directory.organizationsByIds(orgs)) {
        organizations.set(org.organizationId, org.displayName);
      }
    }
  } catch {
    // identity indisponible : noms vides, la lecture n'en dépend pas.
  }
  return {
    holder: (holder) => (holder.type === 'user' ? users : organizations).get(holder.id) ?? '',
    user: (userId) => (userId ? (users.get(userId) ?? '') : ''),
  };
}

export function amountsView(record: RecoveryCaseRecord): CaseAmountsView {
  return {
    principal: record.principal,
    interests: record.interests,
    costs: record.costs,
    paid: record.paid,
    waived: 0,
    due: amountDue(record),
    overpaid: 0,
  };
}

export async function caseView(
  deps: ViewDeps,
  record: RecoveryCaseRecord,
  settings: FullSettings,
  now: Date,
): Promise<CaseView> {
  const [names, holidays, stageHistory] = await Promise.all([
    displayNames(deps.directory, [record.creditor], record.assignedAgentId ? [record.assignedAgentId] : []),
    upcomingHolidays(deps.holidays, now),
    deps.caseQueries.stageHistory(record.id),
  ]);
  return {
    record,
    creditorName: names.holder(record.creditor),
    agentName: names.user(record.assignedAgentId),
    amounts: amountsView(record),
    planScale: effectiveScale(record, settings),
    nextDeadline: nextDeadline(record, settings, holidays),
    stageHistory,
  };
}

export async function summaryViews(
  deps: ViewDeps,
  items: readonly CaseSummaryRecord[],
  settings: FullSettings,
  now: Date,
): Promise<CaseSummaryView[]> {
  if (items.length === 0) return [];
  const agents = items.map((item) => item.assignedAgentId).filter((id): id is string => id !== null);
  const [names, holidays] = await Promise.all([
    displayNames(
      deps.directory,
      items.map((item) => item.creditor),
      agents,
    ),
    upcomingHolidays(deps.holidays, now),
  ]);
  return items.map((summary) => ({
    summary,
    creditorName: names.holder(summary.creditor),
    agentName: names.user(summary.assignedAgentId),
    due: amountDue(summary),
    nextDeadline: nextDeadline(summary, settings, holidays),
  }));
}
