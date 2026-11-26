import { AppError } from '@ksp/platform';
import { isLocalDay, type LocalDay } from '../../domain/calendar';
import { type CaseStage, type StageMove } from '../../domain/case';
import {
  buildInstallments,
  canSignNewPlan,
  isWithinScale,
  type PlanRhythm,
  type PlanScale,
  type PlanTerms,
  scaleViolations,
} from '../../domain/payment-plan';
import { CaseErrors } from '../cases/case-errors';
import { amountDue, debtorDisplayName, evidenceEntry } from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { caseSubject } from '../cases/creditor-cases.use-cases';
import {
  type CaseChanges,
  type DebtorData,
  type EvidenceActor,
  type RecoveryCaseRecord,
  type RecoveryOutboxMessage,
} from '../cases/ports';
import { type FullSettings, type IdGenerator } from '../ports';
import { ROLES } from '../shared/access';
import { RecoveryErrors, unwrap } from '../shared/errors';
import {
  type AmicableCommit,
  type AmicableDeps,
  type DecisionRecord,
  type PlanRecord,
} from './amicable.ports';

/** Modèle du protocole d'accord et échéancier chez document (ADR-044), signé par le débiteur. */
export const PLAN_PROTOCOL_TEMPLATE = 'recovery_settlement_agreement';
/** Validité du lien de signature du protocole : 7 jours. */
export const PLAN_SIGNATURE_HOURS = 168;
/** Renvois du lien de signature : un toutes les 2 minutes, 5 envois au plus par échéancier. */
export const PLAN_SIGNATURE_RESEND_SECONDS = 120;
export const PLAN_SIGNATURE_MAX_ROUNDS = 5;

/** Traitement des dossiers (manifeste de la gateway) : équipe du recouvrement, sans la finance. */
export const CASE_WORKERS = [
  ROLES.agent,
  ROLES.supervisor,
  ROLES.legal,
  ROLES.admin,
  ROLES.superAdmin,
] as const;
/** Validation des échéanciers hors barème et file des échéanciers à valider. */
export const PLAN_REVIEWERS = [ROLES.supervisor, ROLES.admin, ROLES.superAdmin] as const;
/** Changement d'étape : superviseurs et juriste ; saut d'étape (R-PR-03) : juriste et administrateurs. */
export const STAGE_CHANGERS = [ROLES.supervisor, ROLES.admin, ROLES.superAdmin, ROLES.legal] as const;
export const STAGE_SKIPPERS = [ROLES.legal, ROLES.admin, ROLES.superAdmin] as const;

const HOUR_MS = 3_600_000;
const RHYTHMS: readonly PlanRhythm[] = ['weekly', 'biweekly', 'monthly'];

export const STAGE_LABELS: Record<CaseStage, string> = {
  notice: 'notification du mandat',
  payment_plan: 'échéancier',
  amicable: 'relance amiable',
  formal_notice: 'mise en demeure',
  bailiff: 'huissier',
  litigation: 'procédure judiciaire',
};

const NATURE_LABELS: Record<string, string> = {
  unpaid_invoice: 'Facture impayée',
  loan: 'Prêt',
  acknowledgment_of_debt: 'Reconnaissance de dette',
  bounced_cheque: 'Chèque impayé',
  service: 'Prestation',
  sale: 'Vente',
  rent: 'Loyers',
  other: 'Autre créance',
};

/** Erreurs de la procédure amiable (en-tête de recovery.proto). Messages en français. */
export const AmicableErrors = {
  contactOutsideHours: (nextAllowedAt: Date) =>
    AppError.precondition(
      'RECOVERY_CONTACT_OUTSIDE_HOURS',
      'Hors des plages de contact du débiteur (8 h – 19 h, du lundi au samedi, hors jours fériés).',
      { nextAllowedAt: nextAllowedAt.toISOString() },
    ),
  planNotFound: () => AppError.notFound('RECOVERY_CASE_NOT_FOUND', 'Cet échéancier est introuvable.'),
  decisionNotFound: () => AppError.notFound('RECOVERY_DECISION_NOT_FOUND', 'Cette décision est introuvable.'),
  decisionClosed: (status: string) =>
    AppError.precondition('RECOVERY_DECISION_CLOSED', 'Cette décision est déjà prise ou expirée.', {
      status,
    }),
  caseSuspended: () =>
    AppError.precondition(
      'RECOVERY_CASE_SUSPENDED',
      'Le dossier est suspendu par une contestation : la procédure reprend après la décision du juriste.',
    ),
  plansRefused: () =>
    AppError.precondition(
      'RECOVERY_PLAN_OUT_OF_SCALE',
      'Le créancier n’accepte pas d’échéancier pour ce dossier : contactez le chargé de votre dossier.',
      { violations: [] },
    ),
  noPhoneForSignature: () =>
    AppError.precondition(
      'RECOVERY_INVALID_TRANSITION',
      'Signature en ligne impossible : aucun téléphone valable du débiteur.',
    ),
  signatureTooSoon: (retryAfterSeconds: number) =>
    AppError.rateLimited(
      'RECOVERY_DEBTOR_CODE_TOO_SOON',
      'Un lien de signature vient d’être envoyé : patientez avant d’en demander un autre.',
      { retryAfterSeconds },
    ),
} as const;

/** Dossier actif, seul état où la procédure avance ; suspendu : contestation en cours. */
export function requireActive(
  record: RecoveryCaseRecord,
  message = 'Seul un dossier actif est traité.',
): void {
  if (record.status === 'active') return;
  if (record.status === 'suspended') throw AmicableErrors.caseSuspended();
  throw CaseErrors.invalidTransition(record.status, message, record.stage);
}

/** Dossier actif ou suspendu : un contact, une note se notent aussi pendant une contestation. */
export function requireOpen(record: RecoveryCaseRecord): void {
  if (record.status !== 'active' && record.status !== 'suspended') {
    throw CaseErrors.invalidTransition(record.status, 'Le dossier n’est plus en cours.', record.stage);
  }
}

/** Débiteur principal : destinataire des messages automatiques et signataire du protocole. */
export function mainDebtor(record: RecoveryCaseRecord): DebtorData {
  const debtor = record.debtors.find((candidate) => candidate.role === 'main') ?? record.debtors[0];
  if (!debtor) throw CaseErrors.invalidTransition(record.status, 'Le dossier n’a pas de débiteur.');
  return debtor;
}

/** Signataire du protocole : le débiteur qui a proposé l'échéancier, sinon le débiteur principal. */
export function signerOf(record: RecoveryCaseRecord, plan: Pick<PlanRecord, 'proposedBy'>): DebtorData {
  const proposer = plan.proposedBy.type === 'debtor' ? plan.proposedBy.id : null;
  return record.debtors.find((debtor) => debtor.id === proposer) ?? mainDebtor(record);
}

/** Étapes où un échéancier se négocie : règle du domaine (mise en demeure comprise). */
export { PLAN_STAGES } from '../../domain/progression';

/** Premières coordonnées valables du débiteur (téléphone E.164, e-mail). */
export function coordinatesOf(debtor: DebtorData): { phone: string | null; email: string | null } {
  const valid = debtor.contacts.filter((contact) => contact.valid);
  return {
    phone: valid.find((contact) => contact.channel === 'phone')?.value ?? null,
    email: valid.find((contact) => contact.channel === 'email')?.value ?? null,
  };
}

export function caseRef(record: RecoveryCaseRecord) {
  return { caseId: record.id, caseNumber: record.number, creditor: record.creditor };
}

/** Texte libre d'une saisie : une ligne ou plusieurs, borné, vide = null. */
export function optionalText(field: string, value: string | undefined, max: number): string | null {
  const text = value?.trim() ?? '';
  if (text.length > max) throw RecoveryErrors.invalid(field, `${max} caractères au plus.`);
  return text || null;
}

export function requireDay(field: string, value: string): LocalDay {
  if (!isLocalDay(value ?? '')) throw RecoveryErrors.invalid(field, 'Date « AAAA-MM-JJ » attendue.');
  return value;
}

/** Instant ISO facultatif : chaîne vide = null. */
export function optionalInstant(field: string, value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw RecoveryErrors.invalid(field, 'Date ISO 8601 attendue.');
  return date;
}

/** Conditions d'un échéancier saisies (`PlanTerms`), contrôlées avant tout calcul. */
export function termsOf(input: {
  firstAmount: number | null;
  firstDueDate: string;
  rhythm: string;
  installmentsCount: number;
}): PlanTerms {
  if (input.firstAmount === null || !Number.isSafeInteger(input.firstAmount) || input.firstAmount <= 0) {
    throw RecoveryErrors.invalid('terms.firstAmount', 'Premier versement entier et positif.');
  }
  const rhythm = input.rhythm as PlanRhythm;
  if (!RHYTHMS.includes(rhythm)) {
    throw RecoveryErrors.invalid('terms.rhythm', 'Valeur attendue : weekly, biweekly, monthly.');
  }
  return {
    firstAmount: input.firstAmount,
    firstDueDate: requireDay('terms.firstDueDate', input.firstDueDate),
    rhythm,
    installmentsCount: input.installmentsCount,
  };
}

/** Échéancier calculé sur le montant dû, contrôlé contre le barème du dossier (6.1). */
export function computePlan(record: RecoveryCaseRecord, terms: PlanTerms, scale: PlanScale, today: LocalDay) {
  const total = amountDue(record);
  const installments = unwrap(buildInstallments(total, terms));
  const violations = scaleViolations(total, installments, scale, today);
  return { total, installments, violations, withinScale: isWithinScale(scale, violations) };
}

/** Échéanciers signés du dossier (soldés, rompus ou renégociés compris) : un échéancier, une renégociation. */
export function renegotiationOf(plans: readonly PlanRecord[]): { renegotiatedFromId: string | null } {
  const signed = plans.filter((plan) => plan.signedAt !== null);
  const outcome = unwrap(canSignNewPlan(signed.length));
  return { renegotiatedFromId: outcome.renegotiation ? signed[0]!.id : null };
}

/** Échéancier en cours d'accord (proposé ou soumis au créancier) : il bloque une proposition concurrente. */
export const isPlanPending = (plan: PlanRecord) =>
  plan.status === 'proposed' || plan.status === 'pending_creditor';

/** Échéancier à valider par le superviseur : proposé hors barème, pas encore envoyé à la signature. */
export const awaitsReview = (plan: PlanRecord) => plan.status === 'proposed' && plan.documentId === null;

/**
 * Protocole d'accord produit depuis le modèle de document et envoyé à la signature du débiteur, par
 * un lien à son téléphone (notification de document, ADR-044) : chaque envoi est un nouveau tour, au
 * protocole propre (idempotent par l'échéancier et le tour).
 */
export async function sendPlanForSignature(
  deps: Pick<AmicableDeps, 'documents' | 'directory' | 'clock'>,
  record: RecoveryCaseRecord,
  plan: PlanRecord,
  settings: FullSettings,
): Promise<PlanRecord> {
  const debtor = signerOf(record, plan);
  const { phone, email } = coordinatesOf(debtor);
  if (!phone) throw AmicableErrors.noPhoneForSignature();
  const names = await displayNames(deps.directory, [record.creditor], []);
  const round = plan.signatureRound + 1;
  const document = await deps.documents.generate({
    template: PLAN_PROTOCOL_TEMPLATE,
    variables: protocolVariables(record, plan, names.holder(record.creditor), settings),
    subject: caseSubject(record.id),
    idempotencyKey: `recovery:plan:${plan.id}:${round}`,
  });
  const signature = await deps.documents.requestSignature({
    documentId: document.id,
    signer: { phone, ...(email ? { email } : {}), displayName: oneLine(debtorDisplayName(debtor), 200) },
    // Sans `notice`, document envoie son invitation : un lien de signature au téléphone du débiteur.
    expiresInHours: PLAN_SIGNATURE_HOURS,
    idempotencyKey: `recovery:plan-signature:${document.id}`,
  });
  const now = deps.clock.now();
  return {
    ...plan,
    documentId: document.id,
    signatureRequestId: signature.signatureId,
    signatureSentAt: now,
    signatureExpiresAt: new Date(now.getTime() + PLAN_SIGNATURE_HOURS * HOUR_MS),
    signatureRound: round,
  };
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max) || 'Débiteur';
}

/** Variables du modèle `recovery_settlement_agreement` v1 (service document). */
export function protocolVariables(
  record: RecoveryCaseRecord,
  plan: PlanRecord,
  creditorName: string,
  settings: FullSettings,
): Record<string, unknown> {
  const debtor = signerOf(record, plan);
  const { phone } = coordinatesOf(debtor);
  const identification = debtor.ifu ?? debtor.rccm;
  const references = record.claims.map((claim) => claim.reference).join(', ');
  return {
    caseReference: record.number,
    creditor: { name: oneLine(creditorName || 'Créancier', 200) },
    debtor: {
      name: oneLine(debtorDisplayName(debtor), 200),
      ...(debtor.address ? { address: oneLine(debtor.address, 300) } : {}),
      ...(identification ? { identification: oneLine(identification, 100) } : {}),
      ...(phone ? { phoneE164: phone } : {}),
    },
    claim: {
      cause: `${NATURE_LABELS[record.nature] ?? 'Créance'} — références : ${references}`.slice(0, 1000),
    },
    agreedTotal: plan.total,
    installments: plan.installments.map((installment) => ({
      dueDate: installment.dueDate,
      amount: installment.amount,
    })),
    paymentInstructions:
      'Chaque échéance se règle à KSP, mandataire du créancier, par Mobile Money ou par carte depuis le ' +
      'lien personnel du débiteur, ou au guichet de KSP contre reçu.',
    graceDays: Math.min(30, Math.max(1, settings.installmentGraceDays)),
  };
}

/**
 * Changement d'étape : passage tracé (historique), entrée du journal et `recovery.case.stage_changed`.
 * Rend le dossier à enregistrer.
 */
export function applyStageMove(
  ids: IdGenerator,
  record: RecoveryCaseRecord,
  move: StageMove,
  input: { actor: EvidenceActor; changedBy: 'system' | 'staff'; reason: string; at: Date },
  changes: CaseChanges,
): RecoveryCaseRecord {
  const next: RecoveryCaseRecord = {
    ...record,
    stage: move.state.stage,
    highestStage: move.state.highestStage,
    updatedAt: input.at,
  };
  const from = move.change.from;
  changes.stageTransitions.push({
    id: ids.next(),
    from,
    to: move.change.to,
    at: input.at,
    by: input.actor,
    reason: input.reason,
    skipReason: move.change.skipReason,
  });
  changes.evidence.push(
    evidenceEntry(ids, next, input.at, input.actor, {
      action: move.change.skipped ? 'stage.skipped' : 'stage.changed',
      kind: 'stage_changed',
      summary:
        `${move.change.skipped ? 'Saut d’étape' : 'Passage'} de « ${from ? STAGE_LABELS[from] : '—'} » à ` +
        `« ${STAGE_LABELS[move.change.to]} » : ${input.reason}`,
    }),
  );
  changes.events.push({
    type: 'recovery.case.stage_changed',
    payload: {
      ...caseRef(next),
      kind: next.kind,
      fromStage: from,
      toStage: move.change.to,
      skipReason: move.change.skipReason,
      changedBy: input.changedBy,
      changedAt: input.at.toISOString(),
    },
  });
  return next;
}

/** Événement d'une décision soumise au créancier (notification au créancier et au chargé). */
export function decisionRequested(
  record: RecoveryCaseRecord,
  decision: DecisionRecord,
): RecoveryOutboxMessage {
  return {
    type: 'recovery.decision.requested',
    payload: {
      ...caseRef(record),
      decisionId: decision.id,
      kind: decision.kind,
      expiresAt: decision.expiresAt.toISOString(),
      requestedAt: decision.requestedAt.toISOString(),
    },
  };
}

/**
 * Écrit une action. Le dossier, s'il est fourni, prend la date de sa dernière action ; une écriture
 * concurrente annule tout (le client recharge et réessaie).
 */
export async function commitAction(
  deps: Pick<AmicableDeps, 'amicable'>,
  commit: AmicableCommit,
): Promise<void> {
  let record = commit.record;
  if (record) {
    const last = commit.changes.evidence.reduce<Date | null>(
      (latest, entry) => (latest === null || entry.occurredAt > latest ? entry.occurredAt : latest),
      record.lastActionAt,
    );
    record = { ...record, lastActionAt: last };
  }
  const outcome = await deps.amicable.commit({ ...commit, ...(record ? { record } : {}) });
  if (outcome === 'stale') throw CaseErrors.concurrentUpdate(commit.record?.status ?? 'active');
}
