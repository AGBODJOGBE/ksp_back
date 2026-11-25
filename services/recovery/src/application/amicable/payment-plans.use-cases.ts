import { localDay } from '../../domain/calendar';
import { advanceStage, canAdvanceStage } from '../../domain/case';
import { openDecision } from '../../domain/decision';
import { installmentStatus, type PlanTerms } from '../../domain/payment-plan';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { MANDATE_SIGNATURE_CONSUMER } from '../cases/case-deadlines.use-cases';
import { UUID } from '../cases/case-input';
import {
  agentActor,
  effectiveScale,
  evidenceEntry,
  requireIdempotencyKey,
  stableId,
} from '../cases/case-rules';
import { requireCaseId } from '../cases/creditor-cases.use-cases';
import { type EvidenceActor, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { type FullSettings } from '../ports';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, requireStaff, type Staff } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import {
  type AmicableChanges,
  type AmicableDeps,
  type InstallmentRecord,
  noAmicableChanges,
  type PlanRecord,
} from './amicable.ports';
import {
  AmicableErrors,
  applyStageMove,
  awaitsReview,
  CASE_WORKERS,
  commitAction,
  computePlan,
  decisionRequested,
  isPlanPending,
  optionalText,
  PLAN_PROTOCOL_TEMPLATE,
  PLAN_REVIEWERS,
  PLAN_SIGNATURE_MAX_ROUNDS,
  PLAN_SIGNATURE_RESEND_SECONDS,
  PLAN_STAGES,
  renegotiationOf,
  requireActive,
  sendPlanForSignature,
  termsOf,
} from './amicable-rules';
import { amountText, longDay, queuedMessage } from './debtor-messages';

/** Conditions saisies (`PlanTerms` du contrat, montant déjà converti). */
export interface TermsInput {
  firstAmount: number | null;
  firstDueDate: string;
  rhythm: string;
  installmentsCount: number;
}

/** Échéances simulées ou proposées : rang, jour, montant, statut du jour. */
export interface PlanSimulation {
  installments: InstallmentRecord[];
  total: number;
  withinScale: boolean;
  violations: string[];
}

const RENEGOTIATION_NOTE = ' (renégociation)';

function requirePlanStage(record: RecoveryCaseRecord): void {
  requireActive(record);
  if (record.stage === null || !PLAN_STAGES.includes(record.stage)) {
    throw CaseErrors.invalidTransition(
      record.status,
      'Un échéancier se négocie à la notification, à l’échéancier ou en relance amiable.',
      record.stage,
    );
  }
}

function planOf(
  deps: Pick<AmicableDeps, 'ids'>,
  id: string,
  record: RecoveryCaseRecord,
  terms: PlanTerms,
  computed: ReturnType<typeof computePlan>,
  input: {
    proposedBy: PlanRecord['proposedBy'];
    renegotiatedFromId: string | null;
    note: string | null;
    now: Date;
  },
): PlanRecord {
  return {
    id,
    caseId: record.id,
    status: 'proposed',
    terms,
    total: computed.total,
    withinScale: computed.withinScale,
    violations: computed.violations,
    proposedBy: input.proposedBy,
    renegotiatedFromId: input.renegotiatedFromId,
    documentId: null,
    signatureRequestId: null,
    signatureSentAt: null,
    signatureExpiresAt: null,
    signatureRound: 0,
    signedAt: null,
    endedAt: null,
    note: input.note,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: input.now,
    version: 0,
    installments: computed.installments.map((installment) => ({
      id: deps.ids.next(),
      rank: installment.rank,
      dueDate: installment.dueDate,
      amount: installment.amount,
      paidAmount: 0,
      status: 'upcoming',
      paidAt: null,
    })),
  };
}

/**
 * Proposition d'un échéancier, du chargé ou du débiteur : calculée sur le dû, contrôlée contre le
 * barème du dossier, une seule renégociation (`RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED`). Un échéancier
 * soumis au créancier bloque toute autre proposition ; un échéancier seulement proposé est remplacé
 * (refusé, son protocole annulé). Dans le barème, le protocole part aussitôt à la signature du
 * débiteur ; hors barème, il attend le superviseur (puis le créancier).
 */
async function proposePlan(
  deps: AmicableDeps,
  record: RecoveryCaseRecord,
  input: {
    id: string;
    terms: TermsInput;
    note: string | null;
    proposedBy: PlanRecord['proposedBy'];
    actor: EvidenceActor;
    debtorProposal: boolean;
  },
): Promise<PlanRecord> {
  const now = deps.clock.now();
  requirePlanStage(record);
  const { settings } = await loadSettings(deps.settings);
  const scale = effectiveScale(record, settings);
  if (input.debtorProposal && !scale.acceptsPaymentPlan) throw AmicableErrors.plansRefused();
  const terms = termsOf(input.terms);
  const computed = computePlan(record, terms, scale, localDay(now));
  const plans = await deps.amicable.plans(record.id);
  const { renegotiatedFromId } = renegotiationOf(plans);
  if (plans.some((plan) => plan.status === 'pending_creditor')) {
    throw CaseErrors.invalidTransition(
      record.status,
      'Un échéancier attend la décision du créancier : une autre proposition attendra sa réponse.',
      record.stage,
    );
  }
  let plan = planOf(deps, input.id, record, terms, computed, {
    proposedBy: input.proposedBy,
    renegotiatedFromId,
    note: input.note,
    now,
  });
  if (plan.withinScale) plan = await sendPlanForSignature(deps, record, plan, settings);

  const amicable = noAmicableChanges();
  const superseded = plans.filter((candidate) => candidate.status === 'proposed');
  for (const old of superseded) {
    amicable.plans.push({ row: { ...old, status: 'rejected', endedAt: now }, expected: old.version });
  }
  amicable.plans.push({ row: plan, expected: null });
  const who = input.debtorProposal ? 'le débiteur' : 'le chargé';
  const changes = noChanges();
  changes.evidence.push(
    evidenceEntry(deps.ids, record, now, input.actor, {
      action: 'plan.proposed',
      kind: 'plan',
      summary:
        `Échéancier de ${formatXof(plan.total)} en ${plan.installments.length} échéances proposé par ${who}` +
        (renegotiatedFromId ? RENEGOTIATION_NOTE : '') +
        (plan.withinScale
          ? ' : dans le barème, protocole envoyé à la signature du débiteur'
          : ' : hors barème, à valider par le superviseur puis le créancier'),
      amount: plan.total,
      ...(plan.documentId ? { ref: { type: 'document' as const, id: plan.documentId } } : {}),
    }),
  );
  await commitAction(deps, { touch: { caseId: record.id, at: now }, changes, amicable });
  await cancelDocuments(deps, superseded, 'Échéancier remplacé par une nouvelle proposition');
  return plan;
}

/** Protocoles non signés devenus sans objet : annulés chez document, sans bloquer (le lien ne sert plus). */
async function cancelDocuments(
  deps: AmicableDeps,
  plans: readonly PlanRecord[],
  reason: string,
): Promise<void> {
  for (const plan of plans) {
    if (!plan.documentId) continue;
    try {
      await deps.documentCancellation.cancel({ documentId: plan.documentId, reason });
    } catch {
      // document indisponible : le protocole remplacé ne sera de toute façon plus reconnu.
    }
  }
}

/** Échéancier négocié par le chargé (ProposePaymentPlan, UC-RC-17), ou renégociation (une seule). */
export class ProposePaymentPlanUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    terms: TermsInput | null;
    note: string;
  }): Promise<PlanRecord> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const id = stableId('recovery-plan', record.id, 'agent', staff.userId, key);
    const known = await this.deps.amicable.plan(id);
    if (known) return known;
    if (!input.terms) throw RecoveryErrors.invalid('terms', 'Conditions de l’échéancier obligatoires.');
    return proposePlan(this.deps, record, {
      id,
      terms: input.terms,
      note: optionalText('note', input.note, 1000),
      proposedBy: { type: 'agent', id: staff.userId },
      actor: agentActor(staff.userId),
      debtorProposal: false,
    });
  }
}

/**
 * Validation d'un échéancier hors barème par le superviseur (ApprovePaymentPlan, R-EC-01) : accordé,
 * il part au créancier (décision `plan_off_scale`, 3 jours, `recovery.decision.requested`) ; refusé,
 * il est clos. Un échéancier dans le barème qui attendrait encore part à la signature.
 */
export class ApprovePaymentPlanUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: { planId: string; decision: string; note: string }): Promise<PlanRecord> {
    const now = this.deps.clock.now();
    const staff: Staff = requireStaff(PLAN_REVIEWERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    if (!UUID.test(input.planId ?? '')) throw AmicableErrors.planNotFound();
    const plan = await this.deps.amicable.plan(input.planId.toLowerCase());
    if (!plan) throw AmicableErrors.planNotFound();
    const record = await this.deps.cases.find(plan.caseId);
    try {
      requireCaseInScope(record, staff);
    } catch {
      throw AmicableErrors.planNotFound();
    }
    const current = record!;
    if (input.decision !== 'approve' && input.decision !== 'reject') {
      throw RecoveryErrors.invalid('decision', 'Valeur attendue : approve, reject.');
    }
    const note = optionalText('note', input.note, 1000);
    if (!awaitsReview(plan)) {
      const replay =
        input.decision === 'reject'
          ? plan.status === 'rejected'
          : plan.status !== 'rejected' && plan.reviewedBy !== null;
      if (replay) return plan;
      throw CaseErrors.invalidTransition(
        current.status,
        'Cet échéancier n’attend pas de validation.',
        current.stage,
      );
    }
    const reviewed: PlanRecord = {
      ...plan,
      reviewedBy: staff.userId,
      reviewedAt: now,
      note: note ?? plan.note,
    };
    const changes = noChanges();
    const amicable = noAmicableChanges();
    const actor = agentActor(staff.userId);
    let next: PlanRecord;
    if (input.decision === 'reject') {
      next = { ...reviewed, status: 'rejected', endedAt: now };
      changes.evidence.push(
        evidenceEntry(this.deps.ids, current, now, actor, {
          action: 'plan.rejected',
          kind: 'plan',
          summary: `Échéancier de ${formatXof(plan.total)} refusé par le superviseur`,
          amount: plan.total,
        }),
      );
    } else {
      requireActive(current);
      const { settings } = await loadSettings(this.deps.settings);
      if (plan.withinScale) {
        next = await sendPlanForSignature(this.deps, current, reviewed, settings);
        changes.evidence.push(
          evidenceEntry(this.deps.ids, current, now, actor, {
            action: 'plan.approved',
            kind: 'plan',
            summary: 'Échéancier validé : protocole envoyé à la signature du débiteur',
            amount: plan.total,
            ref: { type: 'document', id: next.documentId! },
          }),
        );
      } else {
        next = await this.submitToCreditor(current, reviewed, settings, staff, changes, amicable);
      }
    }
    amicable.plans.push({ row: next, expected: plan.version });
    changes.audit.push({
      actorId: staff.userId,
      action: input.decision === 'reject' ? 'plan.rejected' : 'plan.approved',
      entityType: 'recovery_case',
      entityId: current.id,
      at: now,
      details: { planId: plan.id, total: plan.total, withinScale: plan.withinScale },
    });
    await commitAction(this.deps, { touch: { caseId: current.id, at: now }, changes, amicable });
    return { ...next, version: plan.version + 1 };
  }

  private async submitToCreditor(
    record: RecoveryCaseRecord,
    plan: PlanRecord,
    settings: FullSettings,
    staff: Staff,
    changes: ReturnType<typeof noChanges>,
    amicable: AmicableChanges,
  ): Promise<PlanRecord> {
    const now = this.deps.clock.now();
    if (await this.deps.amicable.pendingDecision(record.id, 'plan_off_scale')) {
      throw CaseErrors.invalidTransition(
        record.status,
        'Un échéancier attend déjà la décision du créancier.',
        record.stage,
      );
    }
    const opened = openDecision('plan_off_scale', now, settings);
    const decision = {
      id: this.deps.ids.next(),
      caseId: record.id,
      kind: opened.kind,
      status: opened.status,
      payload: { planId: plan.id },
      requestedBy: staff.userId,
      requestedAt: now,
      expiresAt: opened.expiresAt,
      decidedAt: null,
      decidedBy: null,
      answer: null,
    };
    amicable.decisions.push({ row: decision, expected: null });
    changes.events.push(decisionRequested(record, decision));
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, agentActor(staff.userId), {
        action: 'decision.requested',
        kind: 'decision',
        summary:
          `Échéancier hors barème (${plan.violations.join(', ') || 'barème refusé'}) validé par le superviseur, ` +
          `soumis au créancier jusqu’au ${longDay(localDay(decision.expiresAt))}`,
        amount: plan.total,
      }),
    );
    return { ...plan, status: 'pending_creditor' };
  }
}

/** Échéancier simulé dans le barème du dossier, sans rien enregistrer (SimulateDebtorPaymentPlan). */
export class SimulateDebtorPaymentPlanUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: { caseId: string; terms: TermsInput | null }): Promise<PlanSimulation> {
    const now = this.deps.clock.now();
    const record = await this.deps.cases.find(input.caseId);
    if (!record) throw CaseErrors.caseNotFound();
    requireActive(record);
    if (!input.terms) throw RecoveryErrors.invalid('terms', 'Conditions de l’échéancier obligatoires.');
    const { settings } = await loadSettings(this.deps.settings);
    const today = localDay(now);
    const computed = computePlan(record, termsOf(input.terms), effectiveScale(record, settings), today);
    return {
      installments: computed.installments.map((installment) => ({
        id: '',
        rank: installment.rank,
        dueDate: installment.dueDate,
        amount: installment.amount,
        paidAmount: 0,
        status: installmentStatus(installment, today, settings.installmentGraceDays),
        paidAt: null,
      })),
      total: computed.total,
      withinScale: computed.withinScale,
      violations: computed.violations,
    };
  }
}

/**
 * Proposition du débiteur depuis son espace (ProposeDebtorPaymentPlan, partie 7) : dans le barème,
 * acceptée aussitôt et envoyée à la signature (lien de document à son téléphone) ; hors barème,
 * transmise au chargé. Le créancier qui refuse tout échéancier : `RECOVERY_PLAN_OUT_OF_SCALE`.
 */
export class ProposeDebtorPaymentPlanUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    caseId: string;
    debtorId: string;
    idempotencyKey: string;
    terms: TermsInput | null;
    message: string;
  }): Promise<PlanRecord> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = await this.deps.cases.find(input.caseId);
    if (!record) throw CaseErrors.caseNotFound();
    const id = stableId('recovery-plan', record.id, 'debtor', input.debtorId, key);
    const known = await this.deps.amicable.plan(id);
    if (known) return known;
    if (!input.terms) throw RecoveryErrors.invalid('terms', 'Conditions de l’échéancier obligatoires.');
    return proposePlan(this.deps, record, {
      id,
      terms: input.terms,
      note: optionalText('message', input.message, 1000),
      proposedBy: { type: 'debtor', id: input.debtorId },
      actor: { type: 'debtor', id: input.debtorId },
      debtorProposal: true,
    });
  }
}

/**
 * Nouveau lien de signature du protocole (ResendDebtorPlanSignature, ADR-044) : le protocole en cours
 * est annulé chez document et un nouveau part au téléphone du débiteur ; un envoi toutes les 2
 * minutes, 5 au plus par échéancier.
 */
export class ResendDebtorPlanSignatureUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    caseId: string;
    debtorId: string;
    planId: string;
  }): Promise<{ signatureExpiresAt: Date }> {
    const now = this.deps.clock.now();
    if (!UUID.test(input.planId ?? '')) throw AmicableErrors.planNotFound();
    const plan = await this.deps.amicable.plan(input.planId.toLowerCase());
    if (!plan || plan.caseId !== input.caseId) throw AmicableErrors.planNotFound();
    const record = await this.deps.cases.find(plan.caseId);
    if (!record) throw AmicableErrors.planNotFound();
    if (!isPlanPending(plan) || plan.documentId === null) {
      throw CaseErrors.invalidTransition(
        record.status,
        'Cet échéancier n’attend pas de signature.',
        record.stage,
      );
    }
    requireActive(record);
    const elapsed = plan.signatureSentAt ? (now.getTime() - plan.signatureSentAt.getTime()) / 1000 : Infinity;
    if (elapsed < PLAN_SIGNATURE_RESEND_SECONDS) {
      throw AmicableErrors.signatureTooSoon(Math.ceil(PLAN_SIGNATURE_RESEND_SECONDS - elapsed));
    }
    if (plan.signatureRound >= PLAN_SIGNATURE_MAX_ROUNDS) {
      throw CaseErrors.invalidTransition(
        record.status,
        'Nombre maximal d’envois atteint : le chargé de votre dossier vous recontactera.',
        record.stage,
      );
    }
    await this.deps.documentCancellation.cancel({
      documentId: plan.documentId,
      reason: 'Nouveau lien de signature demandé par le débiteur',
    });
    const { settings } = await loadSettings(this.deps.settings);
    const next = await sendPlanForSignature(this.deps, record, plan, settings);
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(
        this.deps.ids,
        record,
        now,
        { type: 'debtor', id: input.debtorId },
        {
          action: 'plan.signature_resent',
          kind: 'plan',
          summary: `Nouveau lien de signature du protocole d’échéancier envoyé au débiteur (envoi ${next.signatureRound})`,
          ref: { type: 'document', id: next.documentId! },
        },
      ),
    );
    const amicable = noAmicableChanges();
    amicable.plans.push({ row: next, expected: plan.version });
    await commitAction(this.deps, { touch: { caseId: record.id, at: now }, changes, amicable });
    return { signatureExpiresAt: next.signatureExpiresAt! };
  }
}

/**
 * Protocole d'échéancier signé (`document.signature.completed`, modèle `recovery_settlement_agreement`,
 * R-EC-02) : l'échéancier est signé (reconnaissance de dette) et remplace celui qu'il renégocie, les
 * promesses en attente sont annulées, le dossier passe à l'étape « échéancier », le PDF signé rejoint
 * les pièces (montré au débiteur), `recovery.plan.signed` est publié et la confirmation part au
 * débiteur. Idempotent (inbox) ; un protocole remplacé ou inconnu est ignoré.
 */
export class RecordPlanSignatureUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    eventId: string;
    documentId: string;
    template: string;
    producerService: string;
    subjectType: string;
    subjectId: string;
    signedAt: string;
  }): Promise<'recorded' | 'ignored' | 'duplicate'> {
    if (
      input.template !== PLAN_PROTOCOL_TEMPLATE ||
      input.producerService !== 'recovery' ||
      input.subjectType !== 'recovery_case' ||
      !UUID.test(input.subjectId) ||
      !UUID.test(input.documentId)
    ) {
      return 'ignored';
    }
    const parsed = new Date(input.signedAt);
    const signedAt = Number.isNaN(parsed.getTime()) ? this.deps.clock.now() : parsed;
    const { settings } = await loadSettings(this.deps.settings);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const plan = await this.deps.amicable.planByDocument(input.documentId.toLowerCase());
      if (!plan || plan.caseId !== input.subjectId.toLowerCase() || !isPlanPending(plan)) return 'ignored';
      const record = await this.deps.cases.find(plan.caseId);
      if (!record) return 'ignored';
      const outcome = await this.deps.amicable.commit(
        await this.signature(record, plan, signedAt, settings, input.eventId),
      );
      if (outcome === 'saved') return 'recorded';
      if (outcome === 'duplicate') return 'duplicate';
    }
    throw CaseErrors.concurrentUpdate('active');
  }

  private async signature(
    record: RecoveryCaseRecord,
    plan: PlanRecord,
    signedAt: Date,
    settings: FullSettings,
    eventId: string,
  ) {
    const now = this.deps.clock.now();
    const today = localDay(now);
    const debtorActor: EvidenceActor =
      plan.proposedBy.type === 'debtor'
        ? { type: 'debtor', id: plan.proposedBy.id }
        : { type: 'debtor', id: null };
    const changes = noChanges();
    const amicable = noAmicableChanges();
    for (const running of (await this.deps.amicable.plans(record.id)).filter(
      (other) => other.status === 'signed',
    )) {
      amicable.plans.push({
        row: { ...running, status: 'cancelled', endedAt: signedAt },
        expected: running.version,
      });
    }
    const signed: PlanRecord = {
      ...plan,
      status: 'signed',
      signedAt,
      installments: plan.installments.map((installment) => ({
        ...installment,
        status: installmentStatus(installment, today, settings.installmentGraceDays),
      })),
    };
    amicable.plans.push({ row: signed, expected: plan.version });
    for (const promise of await this.deps.amicable.promises(record.id)) {
      if (promise.status === 'pending')
        amicable.promises.push({ row: { ...promise, status: 'cancelled' }, expected: 'pending' });
    }

    let next: RecoveryCaseRecord = {
      ...record,
      updatedAt: now,
      documents: [
        ...record.documents,
        {
          id: this.deps.ids.next(),
          kind: 'payment_plan',
          label: 'Protocole d’accord et échéancier signé',
          fileId: null,
          documentId: plan.documentId,
          visibleToPartner: false,
          visibleToDebtor: true,
          addedBy: debtorActor,
          addedAt: signedAt,
        },
      ],
    };
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, signedAt, debtorActor, {
        action: 'plan.signed',
        kind: 'plan',
        summary:
          `Protocole d’échéancier signé par le débiteur (signature électronique par code, reconnaissance de ` +
          `dette) : ${formatXof(plan.total)} en ${plan.installments.length} échéances` +
          (plan.renegotiatedFromId ? RENEGOTIATION_NOTE : ''),
        amount: plan.total,
        ref: { type: 'document', id: plan.documentId! },
      }),
    );
    if (
      record.status === 'active' &&
      record.stage !== null &&
      canAdvanceStage(record.stage, 'payment_plan')
    ) {
      next = applyStageMove(
        this.deps.ids,
        next,
        unwrap(advanceStage(record, 'payment_plan')),
        { actor: debtorActor, changedBy: 'system', reason: 'Échéancier signé par le débiteur', at: now },
        changes,
      );
    }
    const first = plan.installments[0]!;
    changes.events.push({
      type: 'recovery.plan.signed',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        planId: plan.id,
        total: { amount: plan.total, currency: 'XOF' },
        installmentsCount: plan.installments.length,
        firstDueDate: first.dueDate,
        renegotiation: plan.renegotiatedFromId !== null,
        documentId: plan.documentId!,
        signedAt: signedAt.toISOString(),
      },
    });
    const signer = plan.proposedBy.type === 'debtor' ? plan.proposedBy.id : null;
    const debtorId = record.debtors.find((debtor) => debtor.id === signer)?.id ?? record.debtors[0]?.id;
    if (debtorId) {
      amicable.messages.push(
        queuedMessage(this.deps.ids, {
          caseId: record.id,
          debtorId,
          message: 'plan_confirmed',
          purpose: 'plan_confirmed',
          dedupeKey: `plan-confirmed:${plan.id}`,
          notBefore: now,
          refId: plan.id,
          variables: {
            total: amountText(plan.total),
            installments: String(plan.installments.length),
            first_due_on: longDay(first.dueDate),
          },
        }),
      );
    }
    const last = changes.evidence.reduce(
      (latest, entry) => (entry.occurredAt > latest ? entry.occurredAt : latest),
      now,
    );
    return {
      record: { ...next, lastActionAt: last },
      changes,
      amicable,
      inbox: { eventId, consumer: MANDATE_SIGNATURE_CONSUMER },
    };
  }
}
