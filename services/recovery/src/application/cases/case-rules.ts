import { createHash } from 'node:crypto';
import { addBusinessDays, daysBetween, localDay, localInstant, type LocalDay } from '../../domain/calendar';
import { type CaseStatus } from '../../domain/case';
import { feePaymentDeadline, infoCompletionDeadline } from '../../domain/deadlines';
import { payOrderEligibility } from '../../domain/eligibility';
import { type PlanScale } from '../../domain/payment-plan';
import {
  DEFAULT_SCORE_SETTINGS,
  type EvidenceQuality,
  recoverabilityScore,
  type ScoreInput,
} from '../../domain/score';
import { type FullSettings, type HolidayStore, type IdGenerator } from '../ports';
import { RecoveryErrors } from '../shared/errors';
import {
  type CaseScore,
  type DebtorData,
  type EvidenceActor,
  type EvidenceEntryData,
  type JournalKind,
  type PageRequest,
  type RecoveryCaseRecord,
} from './ports';

/** Clé d'idempotence d'une requête du créancier ou du back-office : 8 à 100 caractères. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export function requireIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY.test(key ?? '')) {
    throw RecoveryErrors.invalid('idempotencyKey', 'Clé de 8 à 100 caractères (lettres, chiffres, _ et -).');
  }
  return key;
}

/**
 * Identifiant stable d'un objet créé sous une clé d'idempotence (UUID dérivé par SHA-256) : un envoi
 * rejoué après une panne retrouve le même objet chez file (pièces déjà rattachées), sans doublon.
 */
export function stableId(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function requirePage(page: { limit?: number; cursor?: string } | undefined): PageRequest {
  const limit = page?.limit && page.limit > 0 ? page.limit : 20;
  if (limit > 100) throw RecoveryErrors.invalid('page.limit', '100 au plus.');
  return { limit, cursor: page?.cursor || null };
}

/**
 * Mots d'un nom, pour la recherche exacte par empreinte (ADR-063 : un nom chiffré ne se cherche pas
 * par fragment) : minuscules, sans accents ni ponctuation, trois lettres au moins.
 */
export function nameTokens(text: string): string[] {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  return [...new Set(words)];
}

/** Nom affiché d'un débiteur : raison sociale, ou prénoms et nom. */
export function debtorDisplayName(
  debtor: Pick<DebtorData, 'kind' | 'firstNames' | 'lastName' | 'legalName'>,
): string {
  if (debtor.kind === 'company') return debtor.legalName ?? '';
  return [debtor.firstNames, debtor.lastName].filter(Boolean).join(' ');
}

/** Montant dû (R-SD-08) : principal + intérêts + frais − payé, jamais négatif. */
export function amountDue(
  record: Pick<RecoveryCaseRecord, 'principal' | 'interests' | 'costs' | 'paid'>,
): number {
  return Math.max(0, record.principal + record.interests + record.costs - record.paid);
}

/** Paiements reçus par le créancier avant l'envoi. */
export function priorPayments(record: Pick<RecoveryCaseRecord, 'claims'>): number {
  return record.claims.reduce((sum, claim) => sum + claim.paidBefore, 0);
}

/** Barème du dossier : le sien (ou celui du créancier copié à la création), sinon celui de KSP. */
export function effectiveScale(
  record: Pick<RecoveryCaseRecord, 'planScale' | 'kind'>,
  settings: FullSettings,
): PlanScale {
  return record.planScale ?? settings.scales[record.kind];
}

/** Statuts d'un dossier qui ne bouge plus : refusé ou clos. */
export const TERMINAL_STATUSES: readonly CaseStatus[] = ['closed', 'rejected'];
/** Statuts d'un dossier pas encore envoyé : brouillon et frais à payer. */
export const UNPAID_STATUSES: readonly CaseStatus[] = ['draft', 'awaiting_fee'];

export type DeadlineKind = 'fee_payment' | 'review' | 'info_completion';

/** Jours fériés des 90 prochains jours (délais en jours ouvrés). */
export async function upcomingHolidays(holidays: HolidayStore, now: Date): Promise<Set<LocalDay>> {
  const today = localDay(now);
  const until = localDay(new Date(now.getTime() + 90 * 86_400_000));
  return new Set((await holidays.between(today, until)).map((holiday) => holiday.date));
}

/**
 * Échéance suivante d'un dossier avant son acceptation : paiement des frais (brouillon), fin de
 * l'examen (jours ouvrés), complément à fournir. Les échéances des étapes viennent avec R3.
 */
export function nextDeadline(
  record: Pick<RecoveryCaseRecord, 'status' | 'createdAt' | 'submittedAt' | 'infoRequestedAt'>,
  settings: FullSettings,
  holidays: ReadonlySet<LocalDay>,
): { kind: DeadlineKind; dueAt: Date } | null {
  switch (record.status) {
    case 'draft':
    case 'awaiting_fee':
      return { kind: 'fee_payment', dueAt: feePaymentDeadline(record.createdAt, settings) };
    case 'under_review':
      return record.submittedAt
        ? {
            kind: 'review',
            dueAt: localInstant(
              addBusinessDays(localDay(record.submittedAt), settings.reviewBusinessDays, holidays),
              23,
              59,
            ),
          }
        : null;
    case 'info_requested':
      return record.infoRequestedAt
        ? { kind: 'info_completion', dueAt: infoCompletionDeadline(record.infoRequestedAt, settings) }
        : null;
    default:
      return null;
  }
}

/**
 * Qualité des preuves pour le score (R-SD-07). Le contrat d'AssessCase ne la fait pas saisir : elle
 * est déduite des pièces, une reconnaissance de dette prouvée ou trois pièces valant des preuves
 * solides (règle à valider avec le métier).
 */
export function evidenceQuality(
  record: Pick<RecoveryCaseRecord, 'documents' | 'priorEffort'>,
): EvidenceQuality {
  const pieces = record.documents.filter((document) => document.kind === 'evidence').length;
  if ((record.priorEffort.acknowledged && record.priorEffort.acknowledgmentFileId) || pieces >= 3) {
    return 'strong';
  }
  return pieces > 0 ? 'medium' : 'weak';
}

/** Valeurs du score d'un dossier : ancienneté, reconnaissance, preuves, montant, contacts, paiements. */
export function scoreInput(record: RecoveryCaseRecord, today: LocalDay): ScoreInput {
  const contacts = record.debtors.reduce(
    (sum, debtor) =>
      sum + debtor.contacts.filter((contact) => contact.valid).length + (debtor.address ? 1 : 0),
    0,
  );
  return {
    debtAgeDays: record.earliestDueDate ? Math.max(0, daysBetween(record.earliestDueDate, today)) : 0,
    writtenAcknowledgment: record.priorEffort.acknowledged,
    evidenceQuality: evidenceQuality(record),
    amountDue: amountDue(record),
    validContactCount: contacts,
    partialPaymentsMade: priorPayments(record) > 0,
  };
}

/** Score de recouvrabilité (R-SD-07) avec les poids réglés au back-office. */
export function computeScore(record: RecoveryCaseRecord, settings: FullSettings, now: Date): CaseScore {
  const inputs = scoreInput(record, localDay(now));
  const score = recoverabilityScore(inputs, { ...DEFAULT_SCORE_SETTINGS, weights: settings.scoreWeights });
  return { value: score.value, breakdown: score.breakdown, inputs, computedAt: now };
}

/** Critères de l'injonction de payer réunis (étape 6) : créance certaine, liquide, exigible. */
export function injunctionEligible(record: RecoveryCaseRecord, today: LocalDay): boolean {
  if (!record.earliestDueDate) return false;
  return payOrderEligibility({
    nature: record.nature,
    disputed: record.status === 'suspended',
    hasEvidence: record.documents.some((document) => document.kind === 'evidence'),
    amountDetermined: record.principal > 0,
    dueDay: record.earliestDueDate,
    today,
  }).eligible;
}

/** Entrée du journal de preuve d'un dossier (horodatée, attribuée). */
export function evidenceEntry(
  ids: IdGenerator,
  record: Pick<RecoveryCaseRecord, 'id'>,
  at: Date,
  actor: EvidenceActor,
  entry: {
    action: string;
    kind: JournalKind;
    summary: string;
    amount?: number | null;
    internal?: boolean;
    ref?: EvidenceEntryData['ref'];
  },
): EvidenceEntryData {
  return {
    id: ids.next(),
    caseId: record.id,
    occurredAt: at,
    actor,
    action: entry.action,
    kind: entry.kind,
    summary: entry.summary,
    channel: null,
    direction: null,
    outcome: null,
    deliveryStatus: null,
    amount: entry.amount ?? null,
    internal: entry.internal ?? false,
    ref: entry.ref ?? null,
  };
}

export const SYSTEM: EvidenceActor = { type: 'system', id: null };
export const creditorActor = (userId: string): EvidenceActor => ({ type: 'creditor', id: userId });
export const agentActor = (userId: string): EvidenceActor => ({ type: 'agent', id: userId });

/** Fiche vide d'un nouveau dossier (brouillon), complétée par sa saisie. */
export function emptyCase(input: {
  id: string;
  creditor: RecoveryCaseRecord['creditor'];
  createdBy: string;
  source: RecoveryCaseRecord['source'];
  importId: string | null;
  idempotencyKey: string | null;
  planScale: PlanScale | null;
  now: Date;
}): RecoveryCaseRecord {
  return {
    id: input.id,
    number: '',
    kind: 'b2b',
    nature: 'unpaid_invoice',
    status: 'draft',
    stage: null,
    highestStage: null,
    creditor: input.creditor,
    createdBy: input.createdBy,
    source: input.source,
    importId: input.importId,
    communeKey: null,
    preserveRelationship: false,
    planScale: input.planScale,
    assignedAgentId: null,
    score: null,
    rejectionReason: null,
    closureReason: null,
    reviewNote: null,
    completionNote: null,
    assessmentKey: null,
    mandate: null,
    pricing: null,
    fee: {
      amount: 0,
      studyFee: 0,
      debitAttemptedAt: null,
      paidAt: null,
      debitTransactionId: null,
      refundTransactionId: null,
      refundedAt: null,
      studyFeeTransactionId: null,
      studyFeeChargedAt: null,
    },
    principal: 0,
    interests: 0,
    costs: 0,
    paid: 0,
    earliestDueDate: null,
    prescriptionDate: null,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.now,
    updatedAt: input.now,
    submittedAt: null,
    acceptedAt: null,
    infoRequestedAt: null,
    lastActionAt: input.now,
    version: 0,
    debtors: [],
    claims: [],
    priorEffort: {
      remindersCount: 0,
      lastReminderDate: null,
      channels: [],
      acknowledged: false,
      acknowledgmentFileId: null,
      promises: null,
    },
    documents: [],
  };
}
