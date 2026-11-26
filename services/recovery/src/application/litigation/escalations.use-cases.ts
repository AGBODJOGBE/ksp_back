import { localDay } from '../../domain/calendar';
import { advanceStage } from '../../domain/case';
import { type DecisionKind, expireDecision, openDecision } from '../../domain/decision';
import {
  escalationRequest,
  type FeeLine,
  feeQuoteTotals,
  PAID_STAGES,
  type PaidStage,
  partnerFitsStage,
} from '../../domain/litigation';
import { type PartnerKind } from '../../domain/partner';
import { type DecisionRecord } from '../amicable/amicable.ports';
import {
  applyStageMove,
  decisionRequested,
  mainDebtor,
  optionalInstant,
  optionalText,
  requireActive,
  STAGE_LABELS,
} from '../amicable/amicable-rules';
import { longDay } from '../amicable/debtor-messages';
import { type DecisionView } from '../amicable/decisions.use-cases';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { isRefusal, translateRefusal } from '../cases/case-fees';
import { UUID } from '../cases/case-input';
import {
  agentActor,
  amountDue,
  creditorActor,
  debtorDisplayName,
  evidenceEntry,
  requireIdempotencyKey,
  stableId,
  SYSTEM,
} from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import { noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { CaseClosure } from '../money/case-closure.service';
import { loadSettings } from '../settings.use-cases';
import { CRITICAL_MFA_SECONDS, requireStaff } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import { type EscalationAnswer, type EscalationDecisions, type FeeQuoteView } from './escalation.port';
import {
  type FeeQuoteRecord,
  type LitigationDeps,
  noLitigationWrites,
  type PartnerRecord,
  type ProvisionRecord,
} from './litigation.ports';
import {
  commitLitigation,
  LEGAL_ROLES,
  LitigationErrors,
  oneLine,
  PAID_STAGE_LABELS,
  PARTNER_KIND_LABELS,
} from './litigation-rules';
import { feeQuoteView } from './litigation-views';

/**
 * Étapes payantes (R-PR-04, UC-RC-06) : le juriste soumet au créancier le devis des frais d'huissier, de
 * greffe ou d'avocat, avec le partenaire proposé (R-HU-02) ; le créancier l'accepte en ligne, ce qui
 * débite la provision de son portefeuille prépayé (le total du devis : KSP n'avance jamais de frais,
 * ADR-060 point 10) et ouvre l'étape ; sans accord dans le délai, le dossier est clos « abandon par le
 * créancier ». Une provision complémentaire (dépassement, nouveau partenaire) suit le même chemin, à
 * l'étape en cours.
 */

const TEMPLATE = 'recovery_fee_quote';
const ESCALATION_KINDS: Record<PaidStage, DecisionKind> = {
  bailiff: 'bailiff_escalation',
  litigation: 'litigation_escalation',
};
/** Clé du débit de la provision chez wallet : une par devis, rejouable. */
export const provisionKey = (feeQuoteId: string) => `recovery:provision:${feeQuoteId}`;

export const isEscalationDecision = (kind: DecisionKind) =>
  kind === 'bailiff_escalation' || kind === 'litigation_escalation';

/** Catégorie d'une ligne du modèle de devis : greffe d'après son libellé, sinon le métier du partenaire. */
function lineCategory(label: string, kind: PartnerKind): 'bailiff' | 'court_registry' | 'lawyer' {
  if (/greffe/i.test(label)) return 'court_registry';
  return kind === 'lawyer' ? 'lawyer' : 'bailiff';
}

async function escalationView(
  deps: LitigationDeps,
  quote: FeeQuoteRecord,
  decision: DecisionRecord,
  caseNumber: string,
): Promise<{ quote: FeeQuoteView; decision: DecisionView }> {
  const view = await feeQuoteView(deps, quote);
  return { quote: view, decision: { decision, caseNumber, plan: null, settlement: null, feeQuote: view } };
}

/**
 * Devis soumis au créancier (RequestEscalation) : décision `bailiff_escalation` ou
 * `litigation_escalation` (15 jours, ou jusqu'à la validité du devis si elle est plus proche), PDF du
 * modèle `recovery_fee_quote`, `recovery.decision.requested`. Rejoué avec la même clé : le même devis.
 */
export class RequestEscalationUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    stage: string;
    partnerId: string;
    lines: readonly { label: string; amount: number | null }[];
    validUntil: string;
    note: string;
  }): Promise<{ quote: FeeQuoteView; decision: DecisionView }> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const quoteId = stableId('recovery-fee-quote', record.id, staff.userId, key);
    const known = await this.deps.litigation.feeQuote(quoteId);
    if (known) {
      const decision = await this.deps.amicable.decision(known.decisionId);
      if (decision) return escalationView(this.deps, known, decision, record.number);
    }
    const stage = input.stage as PaidStage;
    if (!PAID_STAGES.includes(stage))
      throw RecoveryErrors.invalid('stage', 'Valeur attendue : bailiff, litigation.');
    requireActive(record);
    const notices = await this.deps.litigation.notices(record.id, 'formal_notice');
    const noticeExpired = notices.some((notice) => notice.deadlineAt !== null && notice.deadlineAt <= now);
    const kind = unwrap(escalationRequest(record, stage, noticeExpired));
    for (const pending of PAID_STAGES) {
      if (await this.deps.amicable.pendingDecision(record.id, ESCALATION_KINDS[pending])) {
        throw CaseErrors.invalidTransition(
          record.status,
          'Un devis attend déjà la décision du créancier.',
          record.stage,
        );
      }
    }
    const partner = await this.requirePartner(input.partnerId, stage);
    const lines = this.lines(input.lines);
    const totals = feeQuoteTotals(lines);
    if (!totals.ok) throw RecoveryErrors.invalid('lines', totals.reason);
    const validUntil = optionalInstant('validUntil', input.validUntil);
    if (!validUntil || validUntil <= now) {
      throw RecoveryErrors.invalid('validUntil', 'Date de validité du devis à venir.');
    }
    const note = optionalText('note', input.note, 1000);
    const due = amountDue(record);
    if (due <= 0)
      throw CaseErrors.invalidTransition(record.status, 'Plus rien n’est dû sur ce dossier.', record.stage);
    const { settings } = await loadSettings(this.deps.settings);
    const decisionKind = ESCALATION_KINDS[stage];
    const opened = openDecision(decisionKind, now, settings);
    const expiresAt = validUntil < opened.expiresAt ? validUntil : opened.expiresAt;
    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const creditorName = names.holder(record.creditor);
    if (!creditorName) throw RecoveryErrors.dependencyUnavailable('identity');
    const document = await this.deps.documents.generate({
      template: TEMPLATE,
      variables: {
        caseReference: record.number,
        creditor: { name: oneLine(creditorName, 200) },
        debtor: { name: oneLine(debtorDisplayName(mainDebtor(record)), 200) || 'Débiteur' },
        stage,
        partner: {
          kind: partner.kind,
          name: oneLine(partner.name, 200),
          ...(partner.office ? { office: oneLine(partner.office, 200) } : {}),
        },
        amountDue: due,
        lines: lines.map((line) => ({ category: lineCategory(line.label, partner.kind), ...line })),
        total: totals.value.total,
        provision: totals.value.provision,
        acceptBy: localDay(expiresAt),
      },
      subject: caseSubject(record.id),
      idempotencyKey: `recovery:fee-quote:${quoteId}`,
    });
    const decision: DecisionRecord = {
      id: stableId('recovery-fee-quote-decision', quoteId),
      caseId: record.id,
      kind: decisionKind,
      status: 'pending',
      payload: { feeQuoteId: quoteId },
      requestedBy: staff.userId,
      requestedAt: now,
      expiresAt,
      decidedAt: null,
      decidedBy: null,
      answer: null,
    };
    const quote: FeeQuoteRecord = {
      id: quoteId,
      caseId: record.id,
      decisionId: decision.id,
      stage,
      partnerId: partner.id,
      lines,
      total: totals.value.total,
      provision: totals.value.provision,
      documentId: document.id,
      documentNumber: document.number,
      validUntil,
      status: 'pending',
      note,
      createdBy: staff.userId,
      createdAt: now,
      answeredAt: null,
    };
    const actor = agentActor(staff.userId);
    const next: RecoveryCaseRecord = {
      ...record,
      documents: [
        ...record.documents,
        {
          id: stableId('recovery-fee-quote-document', quoteId),
          kind: 'fee_quote',
          label: `Devis des frais ${document.number}`,
          fileId: null,
          documentId: document.id,
          visibleToPartner: false,
          visibleToDebtor: false,
          addedBy: actor,
          addedAt: now,
        },
      ],
    };
    const object =
      kind === 'top_up'
        ? `Provision complémentaire (étape « ${PAID_STAGE_LABELS[stage]} »)`
        : `Passage à l’étape « ${PAID_STAGE_LABELS[stage]} »`;
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, actor, {
        action: 'decision.requested',
        kind: 'decision',
        summary:
          `${object} soumis au créancier jusqu’au ${longDay(localDay(expiresAt))} : devis ${document.number} ` +
          `de ${formatXof(quote.total)} (${PARTNER_KIND_LABELS[partner.kind]} ${oneLine(partner.name, 200)}), ` +
          `provision de ${formatXof(quote.provision)}`,
        amount: quote.provision,
        ref: { type: 'document', id: document.id },
      }),
    );
    changes.events.push(decisionRequested(next, decision));
    changes.audit.push({
      actorId: staff.userId,
      action: 'escalation.requested',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: {
        feeQuoteId: quoteId,
        decisionId: decision.id,
        stage,
        partnerId: partner.id,
        total: quote.total,
      },
    });
    const litigation = noLitigationWrites();
    litigation.feeQuotes.push({ row: quote, expected: null });
    litigation.decisions.push({ row: decision, expected: null });
    await commitLitigation(this.deps, { record: next, changes, litigation });
    return escalationView(this.deps, quote, decision, record.number);
  }

  private async requirePartner(partnerId: string, stage: PaidStage): Promise<PartnerRecord> {
    const partner = UUID.test(partnerId ?? '')
      ? await this.deps.litigation.partner(partnerId.toLowerCase())
      : null;
    if (!partner) throw LitigationErrors.partnerNotFound();
    if (partner.status !== 'active') throw LitigationErrors.partnerNotActive(partner.status);
    if (!partnerFitsStage(partner.kind, stage)) {
      throw RecoveryErrors.invalid('partnerId', 'L’étape « huissier » se confie à un huissier de justice.');
    }
    return partner;
  }

  private lines(input: readonly { label: string; amount: number | null }[]): FeeLine[] {
    return input.map((line) => {
      const label = oneLine(line.label ?? '', 1000);
      if (label.length === 0 || label.length > 140) {
        throw RecoveryErrors.invalid('lines', 'Libellé de 1 à 140 caractères sur chaque ligne.');
      }
      if (line.amount === null || !Number.isSafeInteger(line.amount) || line.amount <= 0) {
        throw RecoveryErrors.invalid(
          'lines',
          'Montant entier en FCFA, strictement positif, sur chaque ligne.',
        );
      }
      return { label, amount: line.amount };
    });
  }
}

/**
 * Décisions des étapes payantes, pour la procédure amiable (lot R4) : devis présenté avec la décision,
 * réponse du créancier exécutée, expiration (R-PR-04).
 */
export class EscalationDecisionsService implements EscalationDecisions {
  private readonly closure: CaseClosure;

  constructor(private readonly deps: LitigationDeps) {
    this.closure = new CaseClosure(deps);
  }

  async feeQuote(id: string): Promise<FeeQuoteView | null> {
    const quote = await this.deps.litigation.feeQuote(id);
    return quote ? feeQuoteView(this.deps, quote) : null;
  }

  /**
   * Accord : provision débitée du portefeuille prépayé (solde insuffisant : RECOVERY_INSUFFICIENT_FUNDS,
   * à rejouer avec la même clé après la recharge), devis accepté, étape payante ouverte (sauf provision
   * complémentaire), dans la transaction de la décision. Refus : devis refusé, le dossier reste à son
   * étape ; la clôture éventuelle revient au superviseur. Si la décision n'attend plus (expirée
   * entre-temps), le débit est rendu.
   */
  async answer(input: EscalationAnswer): Promise<void> {
    const { record, decision } = input;
    const now = this.deps.clock.now();
    const quote = decision.payload.feeQuoteId
      ? await this.deps.litigation.feeQuote(decision.payload.feeQuoteId)
      : null;
    if (!quote || quote.status !== 'pending') {
      throw CaseErrors.invalidTransition(record.status, 'Ce devis n’attend plus de décision.', record.stage);
    }
    const approved = input.answer === 'approve';
    const actor = creditorActor(input.creditorUserId);
    const changes = noChanges();
    const litigation = noLitigationWrites();
    litigation.decisions.push({
      row: {
        ...decision,
        status: approved ? 'approved' : 'rejected',
        decidedAt: now,
        decidedBy: input.creditorUserId,
        answer: {
          answer: input.answer,
          comment: input.comment,
          fileIds: [],
          idempotencyKey: input.idempotencyKey,
        },
      },
      expected: 'pending',
    });
    if (!approved) {
      litigation.feeQuotes.push({
        row: { ...quote, status: 'rejected', answeredAt: now },
        expected: 'pending',
      });
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, actor, {
          action: 'decision.answered',
          kind: 'decision',
          summary: `Devis ${quote.documentNumber} refusé par le créancier : l’étape « ${PAID_STAGE_LABELS[quote.stage]} » n’est pas engagée`,
        }),
      );
      await commitLitigation(this.deps, { touch: { caseId: record.id, at: now }, changes, litigation });
      return;
    }
    requireActive(record);
    const kind = unwrap(escalationRequest(record, quote.stage, true));
    let debit: { transactionId: string; created: boolean };
    try {
      debit = await this.deps.wallet.debit({
        holder: record.creditor,
        amount: quote.provision,
        objectType: 'recovery_provision',
        objectId: quote.id,
        idempotencyKey: provisionKey(quote.id),
        description: `Provision des frais ${record.number}`,
      });
    } catch (error) {
      throw isRefusal(error) ? translateRefusal(error) : error;
    }
    const provision: ProvisionRecord = {
      id: stableId('recovery-provision', quote.id),
      caseId: record.id,
      feeQuoteId: quote.id,
      decisionId: decision.id,
      amount: quote.provision,
      consumed: 0,
      status: 'paid',
      debitTransactionId: debit.transactionId,
      paidAt: now,
    };
    litigation.provisions.push({ row: provision, expected: null });
    litigation.feeQuotes.push({
      row: { ...quote, status: 'accepted', answeredAt: now },
      expected: 'pending',
    });
    let next: RecoveryCaseRecord | null = null;
    if (kind === 'escalation') {
      next = applyStageMove(
        this.deps.ids,
        record,
        unwrap(advanceStage(record, quote.stage, true)),
        {
          actor,
          changedBy: 'staff',
          reason: `Devis ${quote.documentNumber} accepté et provision payée par le créancier`,
          at: now,
        },
        changes,
      );
    }
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, actor, {
        action: 'decision.answered',
        kind: 'decision',
        summary:
          `Devis ${quote.documentNumber} accepté par le créancier : provision de ${formatXof(quote.provision)} ` +
          `payée par son portefeuille` +
          (next ? ` ; passage à l’étape « ${STAGE_LABELS[quote.stage]} »` : ''),
        amount: quote.provision,
      }),
    );
    const outcome = await this.deps.litigation.commit({
      ...(next ? { record: { ...next, lastActionAt: now } } : { touch: { caseId: record.id, at: now } }),
      changes,
      litigation,
    });
    if (outcome === 'saved') return;
    const latest = await this.deps.amicable.decision(decision.id);
    if (latest?.answer?.idempotencyKey === input.idempotencyKey) return;
    if (latest?.status === 'pending') throw CaseErrors.concurrentUpdate(record.status);
    // La décision ne peut plus être prise : le débit de la provision est rendu aussitôt.
    await this.deps.wallet.refund({
      debitTransactionId: debit.transactionId,
      reason: `Devis ${quote.documentNumber} sans suite`,
    });
    throw CaseErrors.invalidTransition(record.status, 'Ce devis n’attend plus de décision.', record.stage);
  }

  /**
   * Devis sans réponse à l'échéance : dossier clos « abandon par le créancier » (R-PR-04) par le service
   * de clôture, puis décision et devis expirés. Rejouable : un dossier déjà clos n'est pas reclos.
   */
  async expire(decision: DecisionRecord): Promise<boolean> {
    const now = this.deps.clock.now();
    const expired = expireDecision({ ...decision, createdAt: decision.requestedAt }, now);
    if (!expired) return false;
    const record = await this.deps.cases.find(decision.caseId);
    if (!record) return false;
    let closed = false;
    if (record.status === 'active' || record.status === 'suspended') {
      await this.closure.close(record.id, {
        reason: 'abandoned_by_creditor',
        actor: SYSTEM,
        note: 'Étape payante sans accord du créancier dans le délai (R-PR-04)',
        staff: null,
      });
      closed = true;
    }
    const quote = decision.payload.feeQuoteId
      ? await this.deps.litigation.feeQuote(decision.payload.feeQuoteId)
      : null;
    const litigation = noLitigationWrites();
    litigation.decisions.push({
      row: { ...decision, status: 'expired', decidedAt: now },
      expected: 'pending',
    });
    if (quote?.status === 'pending') {
      litigation.feeQuotes.push({
        row: { ...quote, status: 'expired', answeredAt: now },
        expected: 'pending',
      });
    }
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, SYSTEM, {
        action: 'decision.expired',
        kind: 'decision',
        summary: closed
          ? 'Étape payante sans accord du créancier dans le délai : dossier clos, abandon par le créancier'
          : 'Devis d’une étape payante expiré sans réponse du créancier',
      }),
    );
    const outcome = await this.deps.litigation.commit({
      touch: { caseId: record.id, at: now },
      changes,
      litigation,
    });
    return outcome === 'saved';
  }
}
