import { cancelForUnpaidVisitFee } from '../../domain/requests/request-lifecycle';
import { expireQuote, isReminderDue, markReminded } from '../../domain/quotes/quote';
import { cancelVisit } from '../../domain/visits/visit';
import { type CleaningDeps } from '../deps';
import {
  audit,
  caseParty,
  catalogNames,
  iso,
  liveVisit,
  money,
  pendingFee,
  saveCase,
  sentQuote,
} from './case-support';
import { visitCancelledEvent } from './client-requests.use-cases';
import { expireProgramQuoteOf, isProgramQuote } from './program-quotes.use-cases';
import { type CaseRecord, type QuoteRecord } from './requests.ports';
import { releaseVisitAgents } from './visit-agenda';
import { applyDebitOutcome, sendDebit, sendRefund, SYSTEM_ACTOR } from './visit-fee-money';

/** Dossiers examinés par passage et par échéance (les suivants au passage suivant). */
export const DEADLINES_BATCH = 100;
/** RV-80 : opération du wallet « en cours » depuis plus de 2 minutes, rejouée avec la même clé. */
export const WALLET_REPLAY_AFTER_MS = 120_000;

export interface DeadlinesReport {
  /** false : une autre réplique tient le verrou, rien n'a été fait. */
  ran: boolean;
  cancelledForUnpaidFee: number;
  expiredQuotes: number;
  remindedQuotes: number;
  closedVisits: number;
  replayedOperations: number;
  failed: number;
}

/**
 * Tâche planifiée des échéances du dossier (UC-NT-44, RV-13), protégée par un verrou consultatif
 * contre deux répliques. Chaque dossier est traité seul (une erreur n'arrête pas les autres) et son
 * écriture reste conditionnée à sa version :
 * - R-FV-03 : frais impayés à l'échéance, demande annulée ; une demande dont un paiement direct créé
 *   avant l'échéance est encore ouvert attend son expiration (RV-89) ;
 * - R-AC-04 : devis envoyé sans réponse à sa date de validité, devis et dossier « expirés », frais
 *   conservés ;
 * - R-DV-04, RV-53 : rappel avant l'expiration, une fois par devis envoyé ;
 * - RV-51 : visite encore vivante d'une demande close, annulée (sans événement si sa date est passée) ;
 * - RV-80, RV-81 : débits et remboursements des frais de visite restés « en cours », rejoués.
 * Acteur des traces : `system`.
 */
export class CaseDeadlinesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<DeadlinesReport> {
    const report: DeadlinesReport = {
      ran: false,
      cancelledForUnpaidFee: 0,
      expiredQuotes: 0,
      remindedQuotes: 0,
      closedVisits: 0,
      replayedOperations: 0,
      failed: 0,
    };
    report.ran = await this.deps.cases.withDeadlinesLock(async () => {
      const now = this.deps.clock.now();
      const settings = await this.deps.caseSettings.caseSettings();
      const candidates = await this.deps.cases.deadlineCandidates(
        now,
        settings.quoteReminderDays,
        DEADLINES_BATCH,
      );
      const each = async (
        ids: string[],
        work: (record: CaseRecord) => Promise<boolean>,
        count: keyof DeadlinesReport,
      ) => {
        for (const id of ids) {
          try {
            const record = await this.deps.cases.findCase(id);
            if (record && (await work(record))) (report[count] as number) += 1;
          } catch {
            report.failed += 1;
          }
        }
      };
      await each(
        candidates.unpaidFeeRequestIds,
        (record) => this.cancelUnpaid(record, now),
        'cancelledForUnpaidFee',
      );
      await each(candidates.expiredQuoteRequestIds, (record) => this.expire(record, now), 'expiredQuotes');
      await each(
        candidates.reminderQuoteRequestIds,
        (record) => this.remind(record, now, settings.quoteReminderDays),
        'remindedQuotes',
      );
      await each(
        candidates.closedWithLiveVisitRequestIds,
        (record) => this.closeVisit(record, now),
        'closedVisits',
      );
      for (const op of await this.deps.cases.stalePendingWalletOperations(
        new Date(now.getTime() - WALLET_REPLAY_AFTER_MS),
        DEADLINES_BATCH,
      )) {
        try {
          if (op.kind === 'credit') await sendRefund(this.deps, op, now);
          else await applyDebitOutcome(this.deps, op, await sendDebit(this.deps, op), now);
          report.replayedOperations += 1;
        } catch {
          report.failed += 1;
        }
      }
    });
    return report;
  }

  private async cancelUnpaid(record: CaseRecord, now: Date): Promise<boolean> {
    const fee = pendingFee(record);
    if (!fee || record.request.status !== 'awaiting_visit_fee') return false;
    const payments = await this.deps.cases.directPayments(record.request.id);
    const waiting = payments.some(
      (payment) =>
        payment.visitFeeId === fee.id &&
        payment.status === 'pending' &&
        fee.dueAt !== null &&
        payment.createdAt.getTime() < fee.dueAt.getTime() &&
        (payment.expiresAt === null || payment.expiresAt.getTime() > now.getTime()),
    );
    if (waiting) return false;
    const outcome = cancelForUnpaidVisitFee(record.request.status, fee, now);
    const next: CaseRecord = {
      ...record,
      request: {
        ...record.request,
        status: outcome.requestStatus,
        closedAt: now,
        closingReasonCode: 'visit_fee',
        updatedAt: now,
      },
    };
    await saveCase(this.deps, next, record.request.version, {
      changes: {
        events: [
          {
            type: 'cleaning.request.cancelled',
            payload: {
              ...caseParty(record.request),
              cause: 'visit_fee_unpaid',
              visitFeeRefund: null,
              cancelledAt: iso(now),
            },
          },
        ],
        audit: [
          audit(SYSTEM_ACTOR, 'request.cancelled', 'request', record.request.id, now, {
            cause: outcome.cause,
          }),
        ],
      },
    });
    return true;
  }

  private async expire(record: CaseRecord, now: Date): Promise<boolean> {
    const quote = sentQuote(record);
    if (!quote) return false;
    // Piste P : un devis de renouvellement ou d'avenant expire sans clore le dossier du programme.
    if (isProgramQuote(quote)) {
      await expireProgramQuoteOf(this.deps, record, quote, now);
      return true;
    }
    const outcome = expireQuote({ quote, requestStatus: record.request.status, fees: record.fees, now });
    const expired: QuoteRecord = { ...quote, ...outcome.quote };
    const next: CaseRecord = {
      ...record,
      request: { ...record.request, status: outcome.requestStatus, closedAt: now, updatedAt: now },
      fees: outcome.fees,
      quotes: record.quotes.map((item) => (item.id === quote.id ? expired : item)),
    };
    const names = await catalogNames(this.deps, record.request.placeTypeId, record.request.cleaningTypeIds);
    await saveCase(this.deps, next, record.request.version, {
      changes: {
        events: [
          {
            type: 'cleaning.quote.expired',
            payload: {
              ...caseParty(record.request),
              quoteId: quote.id,
              validUntil: iso(quote.validUntil as Date),
              expiredAt: iso(now),
              communeKey: record.request.communeKey,
              total: money(quote.total),
              ...names,
            },
          },
        ],
        audit: [audit(SYSTEM_ACTOR, 'quote.expired', 'quote', quote.id, now)],
      },
    });
    return true;
  }

  private async remind(record: CaseRecord, now: Date, reminderDays: number): Promise<boolean> {
    const quote = sentQuote(record);
    if (!quote || !isReminderDue(quote, now, reminderDays)) return false;
    const reminded: QuoteRecord = { ...quote, ...markReminded(quote, now) };
    await saveCase(
      this.deps,
      { ...record, quotes: record.quotes.map((item) => (item.id === quote.id ? reminded : item)) },
      record.request.version,
      {
        changes: {
          events: [
            {
              type: 'cleaning.quote.expiry_reminded',
              payload: {
                ...caseParty(record.request),
                quoteId: quote.id,
                total: money(quote.total),
                validUntil: iso(quote.validUntil as Date),
                reminderDays,
                remindedAt: iso(now),
              },
            },
          ],
          audit: [],
        },
      },
    );
    return true;
  }

  private async closeVisit(record: CaseRecord, now: Date): Promise<boolean> {
    const visit = liveVisit(record);
    if (!visit) return false;
    const cause = record.request.status === 'rejected' ? 'request_rejected' : 'request_cancelled';
    const cancelled = cancelVisit(visit, cause, now);
    const released = await releaseVisitAgents(this.deps, visit.id, { by: null, reason: cause, at: now });
    const future = visit.scheduledStart.getTime() > now.getTime();
    await saveCase(
      this.deps,
      {
        ...record,
        visits: record.visits.map((item) => (item.id === visit.id ? { ...item, ...cancelled } : item)),
      },
      record.request.version,
      {
        changes: {
          events: future
            ? [visitCancelledEvent(record, visit.id, visit.scheduledStart, cause, released, null, now)]
            : [],
          audit: [audit(SYSTEM_ACTOR, 'visit.cancelled', 'visit', visit.id, now, { cause })],
        },
      },
    );
    return true;
  }
}
