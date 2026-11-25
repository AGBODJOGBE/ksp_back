import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import {
  type AmicableCommit,
  type AmicableFollowUp,
  type AmicableStore,
  type ContactRecord,
  type DebtorMessageRecord,
  type DecisionRecord,
  type MessagePurpose,
  type PlanRecord,
  type PromiseRecord,
  type RowWrite,
  type SettlementRecord,
  type SettlementStatus,
  type WorkQueueRow,
} from '../../application/amicable/amicable.ports';
import {
  type CaseSummaryRecord,
  type EvidenceActor,
  type EvidenceEntryData,
  type PageRequest,
  type SaveOutcome,
} from '../../application/cases/ports';
import { type DebtorMessage, type Holder, type PersonalData } from '../../application/ports';
import { type MessageChannel } from '../../domain/amicable';
import { localInstant } from '../../domain/calendar';
import { type CaseStage, type CaseStatus } from '../../domain/case';
import { type DecisionKind, type DecisionStatus } from '../../domain/decision';
import {
  type InstallmentStatus,
  type PlanStatus,
  type PlanTerms,
  type ScaleViolation,
} from '../../domain/payment-plan';
import { type PromiseStatus } from '../../domain/promise';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import {
  caseColumns,
  evidenceOf,
  fromDateColumn,
  insertDocuments,
  isUniqueViolation,
  json,
  SUMMARY_INCLUDE,
  summaryOfRow,
  toDateColumn,
  type Tx,
  writeChanges,
} from './prisma-case-rows';
import { CASE_PERSONAL_DATA } from './prisma-cases.repository';

/** Version ou statut lu périmé (ou ligne déjà créée) : annule la transaction en cours. */
class StaleRow extends Error {}

const PLAN_INCLUDE = { installments: { orderBy: { rank: 'asc' } } } satisfies Prisma.PaymentPlanInclude;
type PlanRow = Prisma.PaymentPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;
type ContactRow = Prisma.ContactGetPayload<object>;
type PromiseRow = Prisma.PaymentPromiseGetPayload<object>;
type DecisionRow = Prisma.DecisionGetPayload<object>;
type SettlementRow = Prisma.SettlementGetPayload<object>;
type MessageRow = Prisma.DebtorMessageGetPayload<object>;

const OPEN_STATUSES = ['active', 'suspended'] as const;
const actorOf = (type: string, id: string | null): EvidenceActor => ({
  type: type as EvidenceActor['type'],
  id,
});

function contactOf(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    debtorId: row.debtorId,
    channel: row.channel as ContactRecord['channel'],
    direction: row.direction as ContactRecord['direction'],
    outcome: row.outcome as ContactRecord['outcome'],
    deliveryStatus: row.deliveryStatus,
    note: row.note,
    occurredAt: row.occurredAt,
    by: actorOf(row.byType, row.byId),
    internal: row.internal,
    callbackAt: row.callbackAt,
    callbackDoneAt: row.callbackDoneAt,
    fileId: row.fileId,
  };
}

function promiseOf(row: PromiseRow): PromiseRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    amount: row.amount,
    dueDate: fromDateColumn(row.dueDate)!,
    status: row.status as PromiseStatus,
    createdBy: row.createdBy,
    note: row.note,
    keptAt: row.keptAt,
    brokenAt: row.brokenAt,
    createdAt: row.createdAt,
  };
}

function planOf(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    status: row.status as PlanStatus,
    terms: row.terms as unknown as PlanTerms,
    total: row.total,
    withinScale: !row.outOfScale,
    violations: (row.violations ?? []) as ScaleViolation[],
    proposedBy: { type: row.proposedByType as 'debtor' | 'agent', id: row.proposedById },
    renegotiatedFromId: row.renegotiatedFromId,
    documentId: row.documentId,
    signatureRequestId: row.signatureRequestId,
    signatureSentAt: row.signatureSentAt,
    signatureExpiresAt: row.signatureExpiresAt,
    signatureRound: row.signatureRound,
    signedAt: row.signedAt,
    endedAt: row.endedAt,
    note: row.note,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    version: row.version,
    installments: row.installments.map((installment) => ({
      id: installment.id,
      rank: installment.rank,
      dueDate: fromDateColumn(installment.dueDate)!,
      amount: installment.amount,
      paidAmount: installment.paid,
      status: installment.status as InstallmentStatus,
      paidAt: installment.paidAt,
    })),
  };
}

function planColumns(plan: PlanRecord) {
  return {
    status: plan.status,
    terms: json(plan.terms),
    total: plan.total,
    outOfScale: !plan.withinScale,
    violations: json(plan.violations),
    proposedByType: plan.proposedBy.type,
    proposedById: plan.proposedBy.id,
    renegotiatedFromId: plan.renegotiatedFromId,
    documentId: plan.documentId,
    signatureRequestId: plan.signatureRequestId,
    signatureSentAt: plan.signatureSentAt,
    signatureExpiresAt: plan.signatureExpiresAt,
    signatureRound: plan.signatureRound,
    signedDocumentId: plan.signedAt ? plan.documentId : null,
    signedAt: plan.signedAt,
    endedAt: plan.endedAt,
    note: plan.note,
    reviewedBy: plan.reviewedBy,
    reviewedAt: plan.reviewedAt,
  };
}

function decisionOf(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.type as DecisionKind,
    status: row.status as DecisionStatus,
    payload: row.payload as DecisionRecord['payload'],
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    answer: (row.answer ?? null) as DecisionRecord['answer'],
  };
}

function settlementOf(row: SettlementRow): SettlementRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    payNow: row.payNow,
    waived: row.waived,
    discountBps: row.discountBps,
    validUntil: fromDateColumn(row.validUntil)!,
    status: row.status as SettlementStatus,
    withinScale: row.withinScale,
    proposedBy: row.proposedBy,
    note: row.note,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  };
}

function messageOf(row: MessageRow): DebtorMessageRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    debtorId: row.debtorId,
    message: row.message as DebtorMessage,
    purpose: row.purpose as MessagePurpose,
    dedupeKey: row.dedupeKey,
    variables: row.variables as Record<string, string>,
    refId: row.refId,
    channel: row.channel as MessageChannel | null,
    notBefore: row.notBefore,
    status: row.status as DebtorMessageRecord['status'],
    attempts: row.attempts,
    notificationId: row.notificationId,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
  };
}

function messageColumns(message: DebtorMessageRecord) {
  return {
    message: message.message,
    purpose: message.purpose,
    dedupeKey: message.dedupeKey,
    variables: json(message.variables),
    refId: message.refId,
    channel: message.channel,
    notBefore: message.notBefore,
    status: message.status,
    attempts: message.attempts,
    notificationId: message.notificationId,
    sentAt: message.sentAt,
  };
}

/** Mises à jour d'abord (index partiels : un seul échéancier en cours, une seule remise ouverte). */
const updatesFirst = <T>(writes: readonly RowWrite<T>[]) =>
  [...writes].sort((a, b) => Number(a.expected === null) - Number(b.expected === null));

/** Une seule ligne modifiée attendue, sinon la lecture est périmée. */
function expectOne(result: { count: number }): void {
  if (result.count !== 1) throw new StaleRow();
}

/**
 * Lignes de la procédure amiable (lot R4) : contacts, promesses, échéanciers et échéances, décisions,
 * remises et file des messages au débiteur. Chaque action s'écrit dans une transaction avec le dossier
 * (verrou optimiste du lot R2) ou sa dernière action, le journal de preuve, l'outbox et l'audit ;
 * chaque ligne modifiée l'est au statut (ou à la version) lu. Les encaissements (lot R3) ne sont que
 * lus.
 */
@Injectable()
export class PrismaAmicableStore implements AmicableStore {
  private readonly ids = new UuidV7Generator();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CASE_PERSONAL_DATA) private readonly personal: PersonalData,
  ) {}

  async commit(commit: AmicableCommit): Promise<SaveOutcome> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<SaveOutcome> => {
        if (commit.inbox) {
          const inserted = await tx.$executeRawUnsafe(
            'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
              'ON CONFLICT DO NOTHING',
            commit.inbox.eventId,
            commit.inbox.consumer,
          );
          if (inserted === 0) return 'duplicate';
        }
        const caseId = commit.record?.id ?? commit.touch?.caseId ?? null;
        if (commit.record) {
          expectOne(
            await tx.recoveryCase.updateMany({
              where: { id: commit.record.id, version: commit.record.version },
              data: { ...caseColumns(commit.record), version: { increment: 1 } },
            }),
          );
          await insertDocuments(tx, commit.record);
        } else if (commit.touch) {
          await tx.$executeRaw`
            UPDATE recovery_cases SET last_action_at = GREATEST(COALESCE(last_action_at, ${commit.touch.at}), ${commit.touch.at})
            WHERE id = ${commit.touch.caseId}::uuid`;
        }
        // Un passage d'étape vient toujours avec le dossier : son identifiant est alors connu.
        await writeChanges(tx, caseId ?? '', commit.changes, () => this.ids.next());
        await this.writeRows(tx, commit);
        return 'saved';
      });
    } catch (error) {
      if (error instanceof StaleRow || isUniqueViolation(error)) return 'stale';
      throw error;
    }
  }

  private async writeRows(tx: Tx, { amicable }: AmicableCommit): Promise<void> {
    if (amicable.contacts.length > 0) {
      await tx.contact.createMany({
        data: amicable.contacts.map((contact) => ({
          id: contact.id,
          caseId: contact.caseId,
          debtorId: contact.debtorId,
          channel: contact.channel,
          direction: contact.direction,
          occurredAt: contact.occurredAt,
          byType: contact.by.type,
          byId: contact.by.id,
          outcome: contact.outcome,
          deliveryStatus: contact.deliveryStatus,
          note: contact.note,
          internal: contact.internal,
          callbackAt: contact.callbackAt,
          callbackDoneAt: contact.callbackDoneAt,
          fileId: contact.fileId,
        })),
      });
    }
    for (const done of amicable.callbacksDone) {
      await tx.contact.updateMany({
        where: { caseId: done.caseId, callbackAt: { lt: done.until }, callbackDoneAt: null },
        data: { callbackDoneAt: done.at },
      });
    }
    for (const { row, expected } of updatesFirst(amicable.promises)) {
      const columns = {
        amount: row.amount,
        dueDate: toDateColumn(row.dueDate)!,
        status: row.status,
        note: row.note,
        keptAt: row.keptAt,
        brokenAt: row.brokenAt,
      };
      if (expected === null) {
        await tx.paymentPromise.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            createdBy: row.createdBy,
            createdAt: row.createdAt,
            ...columns,
          },
        });
      } else {
        expectOne(
          await tx.paymentPromise.updateMany({
            where: { id: row.id, status: String(expected) },
            data: columns,
          }),
        );
      }
    }
    for (const { row, expected } of updatesFirst(amicable.plans)) await this.writePlan(tx, row, expected);
    for (const { row, expected } of updatesFirst(amicable.decisions)) {
      const columns = {
        status: row.status,
        payload: json(row.payload),
        decidedAt: row.decidedAt,
        decidedBy: row.decidedBy,
        answer: row.answer === null ? Prisma.DbNull : json(row.answer),
      };
      if (expected === null) {
        await tx.decision.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            type: row.kind,
            requestedBy: row.requestedBy,
            requestedAt: row.requestedAt,
            expiresAt: row.expiresAt,
            ...columns,
          },
        });
      } else {
        expectOne(
          await tx.decision.updateMany({ where: { id: row.id, status: String(expected) }, data: columns }),
        );
      }
    }
    for (const { row, expected } of updatesFirst(amicable.settlements)) {
      if (expected === null) {
        await tx.settlement.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            payNow: row.payNow,
            waived: row.waived,
            discountBps: row.discountBps,
            validUntil: toDateColumn(row.validUntil)!,
            status: row.status,
            withinScale: row.withinScale,
            proposedBy: row.proposedBy,
            note: row.note,
            createdAt: row.createdAt,
            answeredAt: row.answeredAt,
          },
        });
      } else {
        expectOne(
          await tx.settlement.updateMany({
            where: { id: row.id, status: String(expected) },
            data: { status: row.status, answeredAt: row.answeredAt },
          }),
        );
      }
    }
    for (const message of amicable.messageUpdates) {
      await tx.debtorMessage.update({ where: { id: message.id }, data: messageColumns(message) });
    }
    if (amicable.messages.length > 0) {
      // Clé de dédoublonnage déjà prise : message déjà en file (ou envoyé), rien à ajouter.
      await tx.debtorMessage.createMany({
        data: amicable.messages.map((message) => ({
          id: message.id,
          caseId: message.caseId,
          debtorId: message.debtorId,
          createdAt: message.createdAt,
          ...messageColumns(message),
        })),
        skipDuplicates: true,
      });
    }
  }

  private async writePlan(tx: Tx, plan: PlanRecord, expected: string | number | null): Promise<void> {
    if (expected === null) {
      await tx.paymentPlan.create({
        data: {
          id: plan.id,
          caseId: plan.caseId,
          createdAt: plan.createdAt,
          version: 0,
          ...planColumns(plan),
        },
      });
      await tx.installment.createMany({
        data: plan.installments.map((installment) => ({
          id: installment.id,
          planId: plan.id,
          rank: installment.rank,
          dueDate: toDateColumn(installment.dueDate)!,
          amount: installment.amount,
          paid: installment.paidAmount,
          status: installment.status,
          paidAt: installment.paidAt,
        })),
      });
      return;
    }
    expectOne(
      await tx.paymentPlan.updateMany({
        where: { id: plan.id, version: Number(expected) },
        data: { ...planColumns(plan), version: { increment: 1 } },
      }),
    );
    for (const installment of plan.installments) {
      await tx.installment.update({
        where: { id: installment.id },
        data: { paid: installment.paidAmount, status: installment.status, paidAt: installment.paidAt },
      });
    }
  }

  async contact(id: string) {
    const row = await this.prisma.contact.findUnique({ where: { id } });
    return row ? contactOf(row) : null;
  }

  async promise(id: string) {
    const row = await this.prisma.paymentPromise.findUnique({ where: { id } });
    return row ? promiseOf(row) : null;
  }

  async plan(id: string) {
    const row = await this.prisma.paymentPlan.findUnique({ where: { id }, include: PLAN_INCLUDE });
    return row ? planOf(row) : null;
  }

  async planByDocument(documentId: string) {
    const row = await this.prisma.paymentPlan.findFirst({ where: { documentId }, include: PLAN_INCLUDE });
    return row ? planOf(row) : null;
  }

  async decision(id: string) {
    const row = await this.prisma.decision.findUnique({ where: { id } });
    return row ? decisionOf(row) : null;
  }

  async settlement(id: string) {
    const row = await this.prisma.settlement.findUnique({ where: { id } });
    return row ? settlementOf(row) : null;
  }

  async evidence(id: string): Promise<EvidenceEntryData | null> {
    const row = await this.prisma.evidenceEntry.findUnique({ where: { id } });
    return row ? evidenceOf(row) : null;
  }

  async message(dedupeKey: string) {
    const row = await this.prisma.debtorMessage.findUnique({ where: { dedupeKey } });
    return row ? messageOf(row) : null;
  }

  async plans(caseId: string) {
    const rows = await this.prisma.paymentPlan.findMany({
      where: { caseId },
      include: PLAN_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(planOf);
  }

  async promises(caseId: string) {
    const rows = await this.prisma.paymentPromise.findMany({
      where: { caseId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(promiseOf);
  }

  async settlements(caseId: string) {
    const rows = await this.prisma.settlement.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } });
    return rows.map(settlementOf);
  }

  async pendingDecision(caseId: string, kind: DecisionKind) {
    const row = await this.prisma.decision.findFirst({ where: { caseId, type: kind, status: 'pending' } });
    return row ? decisionOf(row) : null;
  }

  async stageStart(caseId: string) {
    const row = await this.prisma.stageTransition.findFirst({
      where: { caseId },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
    });
    return row ? { transitionId: row.id, stage: row.to as CaseStage, at: row.at } : null;
  }

  async hasEvidence(caseId: string, action: string, since: Date) {
    return (
      (await this.prisma.evidenceEntry.count({ where: { caseId, action, occurredAt: { gte: since } } })) > 0
    );
  }

  async collectedSince(caseId: string, since: Date): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ amount: unknown }[]>`
      SELECT COALESCE(SUM(gross - overpaid), 0) AS amount FROM collections
      WHERE case_id = ${caseId}::uuid AND collected_at >= ${since}`;
    return Number(row?.amount ?? 0);
  }

  async activeCases(stages: readonly CaseStage[], afterId: string | null, limit: number) {
    const rows = await this.prisma.recoveryCase.findMany({
      where: { status: 'active', stage: { in: [...stages] }, ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async casesWithoutNotice(limit: number) {
    const rows = await this.prisma.recoveryCase.findMany({
      where: { status: 'active', stage: 'notice', debtorMessages: { none: { purpose: 'notice' } } },
      select: { id: true },
      orderBy: { acceptedAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async signedPlans(afterId: string | null, limit: number) {
    const rows = await this.prisma.paymentPlan.findMany({
      where: { status: 'signed', ...(afterId ? { id: { gt: afterId } } : {}) },
      include: PLAN_INCLUDE,
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(planOf);
  }

  async pendingPromises(afterId: string | null, limit: number) {
    const rows = await this.prisma.paymentPromise.findMany({
      where: { status: 'pending', ...(afterId ? { id: { gt: afterId } } : {}) },
      include: { case: { select: { status: true } } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ promise: promiseOf(row), caseStatus: row.case.status as CaseStatus }));
  }

  async expiredDecisions(now: Date, limit: number) {
    const rows = await this.prisma.decision.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map(decisionOf);
  }

  async expiredSettlements(today: string, limit: number) {
    const rows = await this.prisma.settlement.findMany({
      where: { status: { in: ['proposed', 'accepted'] }, validUntil: { lt: toDateColumn(today)! } },
      orderBy: { validUntil: 'asc' },
      take: limit,
    });
    return rows.map(settlementOf);
  }

  async claimMessages(now: Date, leaseUntil: Date, limit: number) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM debtor_messages WHERE status = 'pending' AND not_before <= ${now}
        ORDER BY not_before LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      const ids = claimed.map((row) => row.id);
      if (ids.length === 0) return [];
      await tx.debtorMessage.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 }, notBefore: leaseUntil },
      });
      const rows = await tx.debtorMessage.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(messageOf);
    });
  }

  async workQueue(scope: { agentId: string | null; plansToValidate: boolean }, until: Date) {
    const open: Prisma.RecoveryCaseWhereInput = { status: { in: [...OPEN_STATUSES] } };
    const mine: Prisma.RecoveryCaseWhereInput = {
      ...open,
      ...(scope.agentId ? { assignedAgentId: scope.agentId } : {}),
    };
    const [callbacks, promises, installments, plans, requests, disputes] = await Promise.all([
      this.prisma.contact.findMany({
        where: { callbackAt: { lt: until }, callbackDoneAt: null, case: mine },
      }),
      this.prisma.paymentPromise.findMany({ where: { status: 'broken', case: mine } }),
      this.prisma.installment.findMany({
        where: { status: 'missed', plan: { status: 'signed', case: mine } },
        include: { plan: { select: { caseId: true } } },
      }),
      this.prisma.paymentPlan.findMany({
        where: { status: 'proposed', documentId: null, case: scope.plansToValidate ? open : mine },
      }),
      this.prisma.callbackRequest.findMany({
        where: { status: 'pending', slotStart: { lt: until }, case: mine },
      }),
      this.prisma.dispute.findMany({ where: { status: 'open', case: mine } }),
    ]);
    const rows: WorkQueueRow[] = [
      ...callbacks.map((row) => ({
        kind: 'promised_callback' as const,
        caseId: row.caseId,
        dueAt: row.callbackAt!,
        note: row.note ?? '',
      })),
      ...promises.map((row) => ({
        kind: 'broken_promise' as const,
        caseId: row.caseId,
        dueAt: row.brokenAt ?? row.createdAt,
        note: row.note ?? '',
      })),
      ...installments.map((row) => ({
        kind: 'missed_installment' as const,
        caseId: row.plan.caseId,
        dueAt: localInstant(fromDateColumn(row.dueDate)!, 0),
        note: `Échéance ${row.rank}`,
      })),
      ...plans.map((row) => ({
        kind: 'plan_to_validate' as const,
        caseId: row.caseId,
        dueAt: row.createdAt,
        note: row.note ?? '',
      })),
      ...requests.map((row) => ({
        kind: 'callback_request' as const,
        caseId: row.caseId,
        dueAt: row.slotStart,
        note: '',
      })),
      ...disputes.map((row) => ({
        kind: 'dispute' as const,
        caseId: row.caseId,
        dueAt: row.openedAt,
        note: '',
      })),
    ];
    return rows;
  }

  async amicableFollowUps(agentId: string | null, limit: number) {
    const cases = await this.prisma.recoveryCase.findMany({
      where: { status: 'active', stage: 'amicable', ...(agentId ? { assignedAgentId: agentId } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    const followUps: AmicableFollowUp[] = [];
    for (const { id } of cases) {
      const start = await this.stageStart(id);
      if (!start) continue;
      const prefix = `amicable:${start.transitionId}:`;
      const [contacts, messages] = await Promise.all([
        this.prisma.contact.findMany({
          where: { caseId: id, direction: 'outbound', occurredAt: { gte: start.at } },
          select: { channel: true, occurredAt: true },
        }),
        this.prisma.debtorMessage.findMany({
          where: { caseId: id, dedupeKey: { startsWith: prefix } },
          select: { dedupeKey: true },
        }),
      ]);
      followUps.push({
        caseId: id,
        transitionId: start.transitionId,
        startedAt: start.at,
        outboundContacts: contacts.map((contact) => ({
          channel: contact.channel as ContactRecord['channel'],
          occurredAt: contact.occurredAt,
        })),
        automaticSteps: messages.map((message) => Number(message.dedupeKey.slice(prefix.length))),
      });
    }
    return followUps;
  }

  async summaries(caseIds: readonly string[]): Promise<CaseSummaryRecord[]> {
    if (caseIds.length === 0) return [];
    const rows = await this.prisma.recoveryCase.findMany({
      where: { id: { in: [...caseIds] } },
      include: SUMMARY_INCLUDE,
    });
    return rows.map((row) => summaryOfRow(row, this.personal));
  }

  async decisionsOf(
    creditor: Holder,
    filter: { statuses: readonly DecisionStatus[]; caseId: string | null },
    page: PageRequest,
  ) {
    const rows = await this.prisma.decision.findMany({
      where: {
        status: { in: [...filter.statuses] },
        case: { creditorType: creditor.type, creditorId: creditor.id },
        ...(filter.caseId ? { caseId: filter.caseId } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      include: { case: { select: { number: true } } },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items = rows
      .slice(0, page.limit)
      .map((row) => ({ decision: decisionOf(row), caseNumber: row.case.number }));
    return {
      items,
      nextCursor: rows.length > page.limit ? items[items.length - 1]!.decision.id : null,
    };
  }
}
