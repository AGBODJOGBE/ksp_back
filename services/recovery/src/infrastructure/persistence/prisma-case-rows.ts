import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Prisma } from '../../../prisma/generated';
import { debtorDisplayName, nameTokens } from '../../application/cases/case-rules';
import {
  type CaseChanges,
  type CaseScore,
  type CaseSummaryRecord,
  type DebtorData,
  type EvidenceEntryData,
  type JournalKind,
  type RecoveryCaseRecord,
  type StageTransitionData,
} from '../../application/cases/ports';
import { type PersonalData } from '../../application/ports';
import {
  type CaseKind,
  type CaseStage,
  type CaseStatus,
  type ClosureReason,
  type RejectionReason,
  type SkipReason,
} from '../../domain/case';
import { type ClaimNature } from '../../domain/eligibility';
import { type PlanScale } from '../../domain/payment-plan';

/**
 * Lignes de la base ↔ dossier de la couche application. Les coordonnées des débiteurs sont chiffrées
 * par FieldCipher (ADR-063) avec un contexte propre à la colonne et à la ligne : un chiffré recopié
 * sur une autre ligne ne se déchiffre pas. Téléphones, e-mails et mots du nom ont leur empreinte de
 * recherche (BlindIndex).
 */
export type Tx = Prisma.TransactionClient;

/** Ordre d'origine : téléphones puis e-mails, le principal d'abord, puis dans l'ordre de saisie. */
const CONTACT_ORDER = [{ channel: 'desc' }, { isPrimary: 'desc' }, { id: 'asc' }] as const;

export const CASE_INCLUDE = {
  debtors: { include: { contacts: { orderBy: [...CONTACT_ORDER] } }, orderBy: { position: 'asc' } },
  claims: { orderBy: { id: 'asc' } },
  priorEffort: true,
  documents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.RecoveryCaseInclude;

export type CaseRow = Prisma.RecoveryCaseGetPayload<{ include: typeof CASE_INCLUDE }>;

/** Débiteur principal seulement : les listes n'affichent que son nom. */
export const SUMMARY_INCLUDE = {
  debtors: { orderBy: { position: 'asc' }, take: 1 },
} satisfies Prisma.RecoveryCaseInclude;

export type SummaryRow = Prisma.RecoveryCaseGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

export const identityContext = (debtorId: string) => `debtors.identity:${debtorId}`;
export const addressContext = (debtorId: string) => `debtors.addresses:${debtorId}`;
export const contactContext = (contactId: string) => `debtor_contacts.value:${contactId}`;

/** Jour « AAAA-MM-JJ » en colonne DATE (minuit UTC du même jour). */
export const toDateColumn = (day: string | null) => (day ? new Date(`${day}T00:00:00.000Z`) : null);
export const fromDateColumn = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

export const json = (value: unknown) => value as Prisma.InputJsonValue;
const jsonOrNull = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : json(value));

interface DebtorIdentity {
  firstNames: string | null;
  lastName: string | null;
  legalName: string | null;
  ifu: string | null;
  rccm: string | null;
  representativeName: string | null;
}

/** Colonnes scalaires du dossier (création et mise à jour). */
export function caseColumns(record: RecoveryCaseRecord) {
  return {
    number: record.number,
    kind: record.kind,
    status: record.status,
    stage: record.stage,
    highestStage: record.highestStage,
    creditorType: record.creditor.type,
    creditorId: record.creditor.id,
    createdByUserId: record.createdBy,
    nature: record.nature,
    source: record.source,
    importId: record.importId,
    communeKey: record.communeKey,
    relationshipToPreserve: record.preserveRelationship,
    preferences: jsonOrNull(record.planScale ? { planScale: record.planScale } : null),
    assignedAgentId: record.assignedAgentId,
    score: record.score?.value ?? null,
    scoreBreakdown: jsonOrNull(
      record.score
        ? {
            breakdown: record.score.breakdown,
            inputs: record.score.inputs,
            computedAt: record.score.computedAt.toISOString(),
          }
        : null,
    ),
    rejectionReason: record.rejectionReason,
    closureReason: record.closureReason,
    mandateDocumentId: record.mandate?.documentId ?? null,
    mandateSignatureId: record.mandate?.signatureRequestId ?? null,
    mandateSignedAt: record.mandate?.signedAt ?? null,
    feeRuleId: record.pricing?.feeRuleId ?? null,
    feeRuleVersion: record.pricing?.feeRuleVersion ?? null,
    commissionRuleId: record.pricing?.commissionRuleId ?? null,
    commissionRuleVersion: record.pricing?.commissionRuleVersion ?? null,
    commissionSummary: record.pricing?.commissionSummary ?? null,
    studyFeeRuleId: record.pricing?.studyFeeRuleId ?? null,
    studyFeeRuleVersion: record.pricing?.studyFeeRuleVersion ?? null,
    caseFee: record.fee.amount,
    studyFee: record.fee.studyFee,
    caseFeePaidAt: record.fee.paidAt,
    caseFeeDebitReference: record.fee.debitTransactionId,
    feeDebitAttemptedAt: record.fee.debitAttemptedAt,
    feeRefundTransactionId: record.fee.refundTransactionId,
    feeRefundedAt: record.fee.refundedAt,
    studyFeeTransactionId: record.fee.studyFeeTransactionId,
    studyFeeChargedAt: record.fee.studyFeeChargedAt,
    principal: record.principal,
    interests: record.interests,
    costs: record.costs,
    paid: record.paid,
    earliestDueDate: toDateColumn(record.earliestDueDate),
    prescriptionDate: toDateColumn(record.prescriptionDate),
    idempotencyKey: record.idempotencyKey,
    submittedAt: record.submittedAt,
    acceptedAt: record.acceptedAt,
    infoRequestedAt: record.infoRequestedAt,
    reviewNote: record.reviewNote,
    completionNote: record.completionNote,
    assessmentKey: record.assessmentKey,
    lastActionAt: record.lastActionAt,
    updatedAt: record.updatedAt,
  };
}

/** Débiteurs, contacts, créances et démarches d'un dossier (chiffrés et indexés). */
export async function insertContent(
  tx: Tx,
  record: RecoveryCaseRecord,
  personal: PersonalData,
): Promise<void> {
  if (record.debtors.length > 0) {
    await tx.debtor.createMany({
      data: record.debtors.map((debtor, position) => {
        const identity: DebtorIdentity = {
          firstNames: debtor.firstNames,
          lastName: debtor.lastName,
          legalName: debtor.legalName,
          ifu: debtor.ifu,
          rccm: debtor.rccm,
          representativeName: debtor.representativeName,
        };
        const hasAddress = debtor.address !== null || debtor.communeKey !== null;
        return {
          id: debtor.id,
          caseId: record.id,
          role: debtor.role,
          kind: debtor.kind,
          identityEnc: personal.encrypt(JSON.stringify(identity), identityContext(debtor.id)),
          addressesEnc: hasAddress
            ? personal.encrypt(
                JSON.stringify({ address: debtor.address, communeKey: debtor.communeKey }),
                addressContext(debtor.id),
              )
            : null,
          position,
          nameTokens: nameTokens(debtorDisplayName(debtor)).map((token) => personal.nameIndex(token)),
        };
      }),
    });
    const contacts = record.debtors.flatMap((debtor) =>
      debtor.contacts.map((contact) => ({
        id: contact.id,
        debtorId: debtor.id,
        channel: contact.channel,
        valueEnc: personal.encrypt(contact.value, contactContext(contact.id)),
        valueIndex:
          contact.channel === 'phone'
            ? personal.phoneIndex(contact.value)
            : personal.emailIndex(contact.value),
        isPrimary: contact.isPrimary,
        valid: contact.valid,
      })),
    );
    if (contacts.length > 0) await tx.debtorContact.createMany({ data: contacts });
  }
  if (record.claims.length > 0) {
    await tx.claim.createMany({
      data: record.claims.map((claim) => ({
        id: claim.id,
        caseId: record.id,
        reference: claim.reference,
        nature: claim.nature,
        principal: claim.principal,
        interests: 0,
        dueDate: toDateColumn(claim.dueDate)!,
        description: claim.description,
        paidBefore: claim.paidBefore,
      })),
    });
  }
  const effort = record.priorEffort;
  await tx.priorEffort.create({
    data: {
      caseId: record.id,
      remindersCount: effort.remindersCount,
      lastReminderAt: toDateColumn(effort.lastReminderDate),
      channels: effort.channels,
      acknowledged: effort.acknowledged,
      acknowledgmentFileId: effort.acknowledgmentFileId,
      promises: effort.promises,
    },
  });
}

/** Remplace débiteurs, créances et démarches (brouillon modifié, complément). */
export async function replaceContent(
  tx: Tx,
  record: RecoveryCaseRecord,
  personal: PersonalData,
): Promise<void> {
  await tx.debtor.deleteMany({ where: { caseId: record.id } });
  await tx.claim.deleteMany({ where: { caseId: record.id } });
  await tx.priorEffort.deleteMany({ where: { caseId: record.id } });
  await insertContent(tx, record, personal);
}

/** Pièces pas encore enregistrées (une pièce ne se retire pas). */
export async function insertDocuments(tx: Tx, record: RecoveryCaseRecord): Promise<void> {
  if (record.documents.length === 0) return;
  await tx.caseDocument.createMany({
    data: record.documents.map((document) => ({
      id: document.id,
      caseId: record.id,
      fileId: document.fileId,
      documentId: document.documentId,
      kind: document.kind,
      label: document.label,
      visibleToPartner: document.visibleToPartner,
      visibleToDebtor: document.visibleToDebtor,
      uploadedByType: document.addedBy.type,
      uploadedById: document.addedBy.id,
      createdAt: document.addedAt,
    })),
    skipDuplicates: true,
  });
}

/**
 * Journal de preuve, passages d'étape, traces d'audit et événements (outbox) d'un changement, dans la
 * transaction de l'état. Un saut d'étape garde son motif dans `reason` (colonne `skipped` posée).
 */
export async function writeChanges(tx: Tx, caseId: string, changes: CaseChanges, nextId: () => string) {
  if (changes.evidence.length > 0) {
    await tx.evidenceEntry.createMany({
      data: changes.evidence.map((entry) => ({
        id: entry.id,
        caseId: entry.caseId,
        occurredAt: entry.occurredAt,
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        action: entry.action,
        kind: entry.kind,
        channel: entry.channel,
        direction: entry.direction,
        summary: entry.summary,
        outcome: entry.outcome,
        deliveryStatus: entry.deliveryStatus,
        amount: entry.amount,
        internal: entry.internal,
        refType: entry.ref?.type ?? null,
        refId: entry.ref?.id ?? null,
      })),
    });
  }
  if (changes.stageTransitions.length > 0) {
    await tx.stageTransition.createMany({
      data: changes.stageTransitions.map((transition) => ({
        id: transition.id,
        caseId,
        from: transition.from,
        to: transition.to,
        at: transition.at,
        byType: transition.by.type,
        byId: transition.by.id,
        reason: transition.skipReason ?? transition.reason,
        skipped: transition.skipReason !== null,
      })),
    });
  }
  if (changes.audit.length > 0) {
    await tx.auditEntry.createMany({
      data: changes.audit.map((entry) => ({
        id: nextId(),
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        at: entry.at,
        ...(entry.details ? { details: json(entry.details) } : {}),
      })),
    });
  }
  for (const event of changes.events) {
    await appendToOutbox(
      tx as unknown as SqlExecutor,
      createEnvelope(event.type, event.payload as never, { producer: 'recovery' }),
    );
  }
}

function decryptJson<T>(personal: PersonalData, value: string | null, context: string): T | null {
  return value ? (JSON.parse(personal.decrypt(value, context)) as T) : null;
}

export function debtorOf(row: CaseRow['debtors'][number], personal: PersonalData): DebtorData {
  const identity = decryptJson<DebtorIdentity>(personal, row.identityEnc, identityContext(row.id))!;
  const address = decryptJson<{ address: string | null; communeKey: string | null }>(
    personal,
    row.addressesEnc,
    addressContext(row.id),
  );
  return {
    id: row.id,
    kind: row.kind as DebtorData['kind'],
    role: row.role as DebtorData['role'],
    ...identity,
    address: address?.address ?? null,
    communeKey: address?.communeKey ?? null,
    contacts: row.contacts.map((contact) => ({
      id: contact.id,
      channel: contact.channel as 'phone' | 'email',
      value: personal.decrypt(contact.valueEnc, contactContext(contact.id)),
      isPrimary: contact.isPrimary,
      valid: contact.valid,
    })),
  };
}

/** Nom affiché du débiteur principal d'une ligne de liste. */
export function mainDebtorName(
  debtors: readonly { id: string; kind: string; identityEnc: string }[],
  personal: PersonalData,
): string {
  const main = debtors[0];
  if (!main) return '';
  const identity = decryptJson<DebtorIdentity>(personal, main.identityEnc, identityContext(main.id))!;
  return debtorDisplayName({ kind: main.kind as DebtorData['kind'], ...identity });
}

function scoreOf(row: { score: number | null; scoreBreakdown: Prisma.JsonValue }): CaseScore | null {
  if (row.score === null || !row.scoreBreakdown) return null;
  const stored = row.scoreBreakdown as unknown as {
    breakdown: CaseScore['breakdown'];
    inputs: CaseScore['inputs'];
    computedAt: string;
  };
  return {
    value: row.score,
    breakdown: stored.breakdown,
    inputs: stored.inputs,
    computedAt: new Date(stored.computedAt),
  };
}

export function caseOf(row: CaseRow, personal: PersonalData): RecoveryCaseRecord {
  const effort = row.priorEffort;
  const planScale = (row.preferences as { planScale?: PlanScale } | null)?.planScale ?? null;
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as CaseKind,
    nature: row.nature as ClaimNature,
    status: row.status as CaseStatus,
    stage: row.stage as CaseStage | null,
    highestStage: row.highestStage as CaseStage | null,
    creditor: { type: row.creditorType, id: row.creditorId },
    createdBy: row.createdByUserId,
    source: row.source as RecoveryCaseRecord['source'],
    importId: row.importId,
    communeKey: row.communeKey,
    preserveRelationship: row.relationshipToPreserve,
    planScale,
    assignedAgentId: row.assignedAgentId,
    score: scoreOf(row),
    rejectionReason: row.rejectionReason as RejectionReason | null,
    closureReason: row.closureReason as ClosureReason | null,
    reviewNote: row.reviewNote,
    completionNote: row.completionNote,
    assessmentKey: row.assessmentKey,
    mandate: row.mandateDocumentId
      ? {
          documentId: row.mandateDocumentId,
          signatureRequestId: row.mandateSignatureId,
          signedAt: row.mandateSignedAt,
        }
      : null,
    pricing:
      row.feeRuleId && row.commissionRuleId
        ? {
            feeRuleId: row.feeRuleId,
            feeRuleVersion: row.feeRuleVersion ?? 0,
            commissionRuleId: row.commissionRuleId,
            commissionRuleVersion: row.commissionRuleVersion ?? 0,
            commissionSummary: row.commissionSummary ?? '',
            studyFeeRuleId: row.studyFeeRuleId,
            studyFeeRuleVersion: row.studyFeeRuleVersion,
          }
        : null,
    fee: {
      amount: row.caseFee,
      studyFee: row.studyFee,
      debitAttemptedAt: row.feeDebitAttemptedAt,
      paidAt: row.caseFeePaidAt,
      debitTransactionId: row.caseFeeDebitReference,
      refundTransactionId: row.feeRefundTransactionId,
      refundedAt: row.feeRefundedAt,
      studyFeeTransactionId: row.studyFeeTransactionId,
      studyFeeChargedAt: row.studyFeeChargedAt,
    },
    principal: row.principal,
    interests: row.interests,
    costs: row.costs,
    paid: row.paid,
    earliestDueDate: fromDateColumn(row.earliestDueDate),
    prescriptionDate: fromDateColumn(row.prescriptionDate),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    acceptedAt: row.acceptedAt,
    infoRequestedAt: row.infoRequestedAt,
    lastActionAt: row.lastActionAt,
    version: row.version,
    debtors: row.debtors.map((debtor) => debtorOf(debtor, personal)),
    claims: row.claims.map((claim) => ({
      id: claim.id,
      reference: claim.reference,
      nature: claim.nature as ClaimNature,
      principal: claim.principal,
      dueDate: fromDateColumn(claim.dueDate)!,
      description: claim.description,
      paidBefore: claim.paidBefore,
    })),
    priorEffort: {
      remindersCount: effort?.remindersCount ?? 0,
      lastReminderDate: fromDateColumn(effort?.lastReminderAt ?? null),
      channels: effort?.channels ?? [],
      acknowledged: effort?.acknowledged ?? false,
      acknowledgmentFileId: effort?.acknowledgmentFileId ?? null,
      promises: effort?.promises ?? null,
    },
    documents: row.documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      label: document.label,
      fileId: document.fileId,
      documentId: document.documentId,
      visibleToPartner: document.visibleToPartner,
      visibleToDebtor: document.visibleToDebtor,
      addedBy: {
        type: document.uploadedByType as RecoveryCaseRecord['documents'][number]['addedBy']['type'],
        id: document.uploadedById,
      },
      addedAt: document.createdAt,
    })),
  };
}

export function summaryOfRow(row: SummaryRow, personal: PersonalData): CaseSummaryRecord {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as CaseKind,
    status: row.status as CaseStatus,
    stage: row.stage as CaseStage | null,
    creditor: { type: row.creditorType, id: row.creditorId },
    debtorName: mainDebtorName(row.debtors, personal),
    principal: row.principal,
    interests: row.interests,
    costs: row.costs,
    paid: row.paid,
    score: row.score,
    assignedAgentId: row.assignedAgentId,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    infoRequestedAt: row.infoRequestedAt,
    lastActionAt: row.lastActionAt,
  };
}

export function evidenceOf(row: {
  id: string;
  caseId: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  kind: string | null;
  summary: string;
  channel: string | null;
  direction: string | null;
  outcome: string | null;
  deliveryStatus: string | null;
  amount: number | null;
  internal: boolean;
  refType: string | null;
  refId: string | null;
}): EvidenceEntryData {
  return {
    id: row.id,
    caseId: row.caseId,
    occurredAt: row.occurredAt,
    actor: { type: row.actorType as EvidenceEntryData['actor']['type'], id: row.actorId },
    action: row.action,
    kind: (row.kind ?? 'system') as JournalKind,
    summary: row.summary,
    channel: row.channel,
    direction: row.direction as EvidenceEntryData['direction'],
    outcome: row.outcome,
    deliveryStatus: row.deliveryStatus,
    amount: row.amount,
    internal: row.internal,
    ref: row.refType && row.refId ? { type: row.refType as 'document' | 'file', id: row.refId } : null,
  };
}

export function transitionOf(row: {
  id: string;
  from: string | null;
  to: string;
  at: Date;
  byType: string;
  byId: string | null;
  reason: string | null;
  skipped: boolean;
}): StageTransitionData {
  return {
    id: row.id,
    from: row.from as CaseStage | null,
    to: row.to as CaseStage,
    at: row.at,
    by: { type: row.byType as StageTransitionData['by']['type'], id: row.byId },
    reason: row.skipped ? null : row.reason,
    skipReason: row.skipped ? (row.reason as SkipReason | null) : null,
  };
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Numéro lisible du dossier : RC suivi de la séquence sur six chiffres au moins. */
export const caseNumber = (sequence: number) => `RC-${String(sequence).padStart(6, '0')}`;
