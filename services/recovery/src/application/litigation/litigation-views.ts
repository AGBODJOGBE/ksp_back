import { displayNames } from '../cases/case-views';
import { type FeeQuoteView, type PartnerRef } from './escalation.port';
import {
  type AssignmentListItem,
  type AssignmentRecord,
  type FeeQuoteRecord,
  type LegalActRecord,
  type LitigationDeps,
  type NoticeRecord,
  type PartnerRecord,
  type PartnerStats,
} from './litigation.ports';
import { partnerRef } from './litigation-rules';

/**
 * Vues du contentieux présentées par l'interface : fiche partenaire et ses chiffres, assignation et
 * ses actes, courrier et son signataire, devis et son partenaire. Un nom indisponible (identity
 * injoignable) reste vide.
 */

export interface PartnerView {
  partner: PartnerRecord;
  stats: PartnerStats;
  verifiedByName: string;
}

const NO_STATS: PartnerStats = {
  openAssignments: 0,
  closedAssignments: 0,
  successfulAssignments: 0,
  averageDays: null,
};

export async function partnerViews(
  deps: Pick<LitigationDeps, 'litigation' | 'directory'>,
  partners: readonly PartnerRecord[],
): Promise<PartnerView[]> {
  if (partners.length === 0) return [];
  const verifiers = partners.map((p) => p.verifiedBy).filter((id): id is string => id !== null);
  const [stats, names] = await Promise.all([
    deps.litigation.partnerStats(partners.map((p) => p.id)),
    displayNames(deps.directory, [], verifiers),
  ]);
  return partners.map((partner) => ({
    partner,
    stats: stats.get(partner.id) ?? NO_STATS,
    verifiedByName: names.user(partner.verifiedBy),
  }));
}

export interface AssignmentView {
  assignment: AssignmentRecord;
  caseNumber: string;
  partner: PartnerRef | null;
  acts: LegalActRecord[];
}

export async function assignmentViews(
  deps: Pick<LitigationDeps, 'litigation'>,
  items: readonly AssignmentListItem[],
): Promise<AssignmentView[]> {
  if (items.length === 0) return [];
  const acts = await deps.litigation.acts(items.map((item) => item.id));
  const partners = new Map<string, PartnerRef | null>();
  for (const id of new Set(items.map((item) => item.partnerId))) {
    const partner = await deps.litigation.partner(id);
    partners.set(id, partner ? partnerRef(partner) : null);
  }
  return items.map(({ caseNumber, ...assignment }) => ({
    assignment,
    caseNumber,
    partner: partners.get(assignment.partnerId) ?? null,
    acts: acts.filter((act) => act.assignmentId === assignment.id),
  }));
}

export interface NoticeView {
  notice: NoticeRecord;
  signedByName: string;
}

export async function noticeViews(
  deps: Pick<LitigationDeps, 'directory'>,
  notices: readonly NoticeRecord[],
): Promise<NoticeView[]> {
  if (notices.length === 0) return [];
  const signers = notices.map((n) => n.signedBy).filter((id): id is string => id !== null);
  const names = await displayNames(deps.directory, [], signers);
  return notices.map((notice) => ({ notice, signedByName: names.user(notice.signedBy) }));
}

export async function feeQuoteView(
  deps: Pick<LitigationDeps, 'litigation'>,
  quote: FeeQuoteRecord,
): Promise<FeeQuoteView> {
  const partner = await deps.litigation.partner(quote.partnerId);
  return { quote, partner: partner ? partnerRef(partner) : null };
}
