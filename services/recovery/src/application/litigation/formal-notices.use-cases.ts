import { remaining } from '../../domain/amounts';
import { localDay } from '../../domain/calendar';
import {
  NOTICE_DEADLINE_DAYS,
  NOTICE_DELIVERY_METHODS,
  type NoticeDeliveryMethod,
  noticeDeadline,
} from '../../domain/litigation';
import { noAmicableChanges } from '../amicable/amicable.ports';
import { mainDebtor, optionalInstant, requireActive, requireOpen } from '../amicable/amicable-rules';
import { longDay, queuedMessage } from '../amicable/debtor-messages';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import {
  agentActor,
  amountDue,
  debtorDisplayName,
  evidenceEntry,
  requireIdempotencyKey,
  stableId,
} from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import { type CaseDocumentData, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { caseAmounts } from '../money/money-rules';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, requireStaff } from '../shared/access';
import { formatXof, RecoveryErrors } from '../shared/errors';
import { type LitigationDeps, noLitigationWrites, type NoticeRecord } from './litigation.ports';
import {
  commitLitigation,
  DELIVERY_LABELS,
  LEGAL_ROLES,
  LitigationErrors,
  oneLine,
} from './litigation-rules';
import { type NoticeView, noticeViews } from './litigation-views';

/**
 * Mise en demeure (UC-RC-19, étape 4) : produite depuis le modèle `recovery_formal_notice` de document
 * (ADR-044), signée par le juriste qui l'émet, annoncée au débiteur par un message dans la plage de
 * contact et au créancier par `recovery.notice.issued` ; puis remise contre décharge, par lettre
 * recommandée, par huissier ou par e-mail, avec sa preuve. Le délai laissé au débiteur court de la
 * remise ; passé ce délai, la tâche du contentieux propose l'huissier (devis du juriste au créancier).
 */

const TEMPLATE = 'recovery_formal_notice';

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

/** Variables du modèle `recovery_formal_notice` v1 : reste dû en principal, intérêts et frais à part. */
async function noticeVariables(
  deps: LitigationDeps,
  record: RecoveryCaseRecord,
  deadlineDays: number,
): Promise<Record<string, unknown>> {
  const names = await displayNames(deps.directory, [record.creditor], []);
  const creditorName = names.holder(record.creditor);
  if (!creditorName) throw RecoveryErrors.dependencyUnavailable('identity');
  const amounts = caseAmounts(record, await deps.money.money(record.id));
  const due = amountDue(record);
  const principalLeft = remaining(amounts.principal);
  const principal = principalLeft > 0 ? Math.min(principalLeft, due) : due;
  const charges = Math.max(0, due - principal);
  const debtor = mainDebtor(record);
  const address = debtor.address ? oneLine(debtor.address, 300) : '';
  const references = record.claims.map((claim) => claim.reference).join(', ');
  return {
    caseReference: record.number,
    creditor: { name: oneLine(creditorName, 200) },
    debtor: {
      name: oneLine(debtorDisplayName(debtor), 200) || 'Débiteur',
      ...(address ? { address } : {}),
    },
    claim: {
      principal,
      cause: `${NATURE_LABELS[record.nature] ?? 'Créance'} — références : ${references}`.slice(0, 1000),
      ...(record.earliestDueDate ? { dueDate: record.earliestDueDate } : {}),
      ...(charges > 0 ? { additionalCharges: charges } : {}),
    },
    paymentDeadlineDays: deadlineDays,
    paymentInstructions:
      'Le règlement se fait à KSP, mandataire du créancier, par Mobile Money ou par carte depuis le lien ' +
      'personnel du débiteur, ou au guichet de KSP contre reçu.',
  };
}

async function noticeView(deps: LitigationDeps, notice: NoticeRecord): Promise<NoticeView> {
  const [view] = await noticeViews(deps, [notice]);
  return view!;
}

/** Émission (IssueFormalNotice), rejouée avec la même clé : la même mise en demeure, message assuré. */
export class IssueFormalNoticeUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    deadlineDays: number;
  }): Promise<NoticeView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const id = stableId('recovery-formal-notice', record.id, staff.userId, key);
    const known = await this.deps.litigation.notice(id);
    if (known) {
      await this.announce(record, known);
      return noticeView(this.deps, known);
    }
    requireActive(record);
    if (record.stage !== 'formal_notice') {
      throw CaseErrors.invalidTransition(
        record.status,
        'La mise en demeure s’émet à l’étape « mise en demeure », après l’escalade validée.',
        record.stage,
      );
    }
    const { settings } = await loadSettings(this.deps.settings);
    const deadlineDays = input.deadlineDays || settings.formalNoticeDays;
    if (
      !Number.isSafeInteger(deadlineDays) ||
      deadlineDays < NOTICE_DEADLINE_DAYS.min ||
      deadlineDays > NOTICE_DEADLINE_DAYS.max
    ) {
      throw RecoveryErrors.invalid(
        'deadlineDays',
        `Délai de ${NOTICE_DEADLINE_DAYS.min} à ${NOTICE_DEADLINE_DAYS.max} jours.`,
      );
    }
    const due = amountDue(record);
    if (due <= 0)
      throw CaseErrors.invalidTransition(record.status, 'Plus rien n’est dû sur ce dossier.', record.stage);
    const document = await this.deps.documents.generate({
      template: TEMPLATE,
      variables: await noticeVariables(this.deps, record, deadlineDays),
      subject: caseSubject(record.id),
      idempotencyKey: `recovery:formal-notice:${id}`,
    });
    const notice: NoticeRecord = {
      id,
      caseId: record.id,
      kind: 'formal_notice',
      documentId: document.id,
      documentNumber: document.number,
      signedBy: staff.userId,
      issuedAt: now,
      deadlineDays,
      deliveryMethod: null,
      deliveredAt: null,
      deliveredBy: null,
      proofFileId: null,
      deadlineAt: null,
    };
    const actor = agentActor(staff.userId);
    const piece: CaseDocumentData = {
      id: stableId('recovery-formal-notice-document', id),
      kind: 'formal_notice',
      label: `Mise en demeure ${document.number}`,
      fileId: null,
      documentId: document.id,
      // Le débiteur la retrouve dans son espace ; l'huissier la reçoit avec le dossier (R-HU-03).
      visibleToPartner: true,
      visibleToDebtor: true,
      addedBy: actor,
      addedAt: now,
    };
    const next = { ...record, documents: [...record.documents, piece] };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, actor, {
        action: 'notice.issued',
        kind: 'letter',
        summary:
          `Mise en demeure ${document.number} produite et signée par le juriste : ${formatXof(due)} à ` +
          `régler dans les ${deadlineDays} jours qui suivent sa réception`,
        amount: due,
        ref: { type: 'document', id: document.id },
      }),
    );
    changes.events.push({
      type: 'recovery.notice.issued',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        noticeId: id,
        documentId: document.id,
        deadlineDays,
        issuedAt: now.toISOString(),
      },
    });
    changes.audit.push({
      actorId: staff.userId,
      action: 'notice.issued',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { noticeId: id, documentId: document.id, deadlineDays },
    });
    const litigation = noLitigationWrites();
    litigation.notices.push({ row: notice, expected: null });
    await commitLitigation(this.deps, { record: next, changes, litigation });
    await this.announce(next, notice);
    return noticeView(this.deps, notice);
  }

  /**
   * Message au débiteur (modèle `recovery.debtor_formal_notice`), mis en file : il part dans la plage de
   * contact, avec un lien personnel renouvelé, par la tâche de la procédure amiable. Une seule fois par
   * mise en demeure.
   */
  private async announce(record: RecoveryCaseRecord, notice: NoticeRecord): Promise<void> {
    const dedupeKey = `formal-notice:${notice.id}`;
    if (await this.deps.amicable.message(dedupeKey)) return;
    const amicable = noAmicableChanges();
    amicable.messages.push(
      queuedMessage(this.deps.ids, {
        caseId: record.id,
        debtorId: mainDebtor(record).id,
        message: 'formal_notice',
        purpose: 'formal_notice',
        dedupeKey,
        notBefore: this.deps.clock.now(),
        variables: { deadline_days: String(notice.deadlineDays ?? NOTICE_DEADLINE_DAYS.min) },
        refId: notice.id,
      }),
    );
    await this.deps.amicable.commit({ changes: noChanges(), amicable });
  }
}

/**
 * Preuve de remise (RecordNoticeDelivery) : mode, date et pièce (décharge, accusé de réception, acte de
 * l'huissier, e-mail). Le délai du débiteur court de cette date. Rejouée à l'identique, elle rend la
 * mise en demeure remise.
 */
export class RecordNoticeDeliveryUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    caseId: string;
    noticeId: string;
    deliveryMethod: string;
    deliveredAt: string;
    proofFileId: string;
  }): Promise<NoticeView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    if (!UUID.test(input.noticeId ?? '')) throw LitigationErrors.noticeNotFound();
    const notice = await this.deps.litigation.notice(input.noticeId.toLowerCase());
    if (!notice || notice.caseId !== record.id || notice.kind !== 'formal_notice') {
      throw LitigationErrors.noticeNotFound();
    }
    const method = input.deliveryMethod as NoticeDeliveryMethod;
    if (!NOTICE_DELIVERY_METHODS.includes(method)) {
      throw RecoveryErrors.invalid(
        'deliveryMethod',
        `Valeur attendue : ${NOTICE_DELIVERY_METHODS.join(', ')}.`,
      );
    }
    const deliveredAt = optionalInstant('deliveredAt', input.deliveredAt);
    if (!deliveredAt || deliveredAt < notice.issuedAt || deliveredAt > now) {
      throw RecoveryErrors.invalid('deliveredAt', 'Date de remise entre l’émission et maintenant.');
    }
    if (!UUID.test(input.proofFileId ?? '')) {
      throw RecoveryErrors.invalid('proofFileId', 'Preuve de remise (fichier) attendue.');
    }
    const proofFileId = input.proofFileId.toLowerCase();
    if (notice.deliveredAt) {
      if (
        notice.deliveryMethod === method &&
        notice.deliveredAt.getTime() === deliveredAt.getTime() &&
        notice.proofFileId === proofFileId
      ) {
        return noticeView(this.deps, notice);
      }
      throw CaseErrors.invalidTransition(
        record.status,
        'La remise de cette mise en demeure est déjà enregistrée.',
        record.stage,
      );
    }
    requireOpen(record);
    await this.deps.files.attach({
      fileId: proofFileId,
      subject: caseSubject(record.id),
      ownerId: staff.userId,
    });
    const { settings } = await loadSettings(this.deps.settings);
    const deadlineAt = noticeDeadline(deliveredAt, notice.deadlineDays ?? settings.formalNoticeDays);
    const delivered: NoticeRecord = {
      ...notice,
      deliveryMethod: method,
      deliveredAt,
      deliveredBy: staff.userId,
      proofFileId,
      deadlineAt,
    };
    const actor = agentActor(staff.userId);
    const documents = record.documents.some((document) => document.fileId === proofFileId)
      ? []
      : [
          {
            id: stableId('recovery-notice-proof', notice.id),
            kind: 'notice_delivery_proof',
            label: `Preuve de remise de la mise en demeure ${notice.documentNumber}`,
            fileId: proofFileId,
            documentId: null,
            visibleToPartner: true,
            visibleToDebtor: false,
            addedBy: actor,
            addedAt: now,
          },
        ];
    const next = { ...record, documents: [...record.documents, ...documents] };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, actor, {
        action: 'notice.delivered',
        kind: 'letter',
        summary:
          `Mise en demeure ${notice.documentNumber} remise (${DELIVERY_LABELS[method]}) le ` +
          `${longDay(localDay(deliveredAt))} : délai du débiteur jusqu’au ${longDay(localDay(deadlineAt))}`,
        ref: { type: 'file', id: proofFileId },
      }),
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'notice.delivered',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { noticeId: notice.id, deliveryMethod: method },
    });
    const litigation = noLitigationWrites();
    litigation.notices.push({ row: delivered, expected: 'issued' });
    await commitLitigation(this.deps, { record: next, changes, litigation });
    return noticeView(this.deps, delivered);
  }
}
