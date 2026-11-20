import { acceptQuote, declineQuote, forwardQuote } from '../../domain/quotes/acceptance';
import { DAY_MS, localDay } from '../../domain/requests/time';
import { type CleaningDeps } from '../deps';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { text } from '../shared/input';
import { decide } from './case-errors';
import {
  audit,
  caseParty,
  catalogNames,
  effectiveQuote,
  effectiveStatus,
  iso,
  money,
  ownedCaseByQuote,
  quoteById,
  saveCase,
} from './case-support';
import { currentCustomer } from './customer';
import { type CaseRecord, type NewProgram, type QuoteRecord } from './requests.ports';

/** Devis accepté et programme confirmé (contrat AcceptQuoteResult). */
export interface AcceptedQuote {
  record: CaseRecord;
  quote: QuoteRecord;
  program: NewProgram & { number: string | null };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * R-AC-01 : le client décale la date de début. Interprétation : toutes les dates du devis glissent du
 * même nombre de jours que la première (même heure, même rythme) ; le domaine contrôle ensuite le
 * délai de la première séance et la limite de validité.
 */
export function shiftedStarts(starts: readonly Date[], startDate: string): Date[] {
  const first = starts[0];
  if (!first) return [...starts];
  const delta = Math.round(
    (Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${localDay(first)}T00:00:00Z`)) / DAY_MS,
  );
  return starts.map((start) => new Date(start.getTime() + delta * DAY_MS));
}

export class ClientQuotesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** UC-NT-07 — Devis envoyé (ou une version précédente), jamais un brouillon. */
  async get(quoteId: string): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
    const { record, quote } = await ownedCaseByQuote(this.deps, currentCustomer(), quoteId);
    return { record, quote: effectiveQuote(quote, this.deps.clock.now()) };
  }

  /**
   * UC-NT-08 — Accepter un devis (R-AC-01, R-AC-02, R-PG-03, R-PG-05, R-FV-05). Le programme est créé
   * avec toutes ses séances « à affecter » et leur part des frais de visite déduits ;
   * `cleaning.program.confirmed` est publié dans la même transaction.
   */
  async accept(input: {
    quoteId: string;
    idempotencyKey: string;
    acceptTerms: boolean;
    termsVersion: string;
    startDate?: string | undefined;
  }): Promise<AcceptedQuote> {
    const customer = currentCustomer();
    if (!input.acceptTerms) throw cleaningErrors.invalid('acceptTerms', 'required');
    if (input.startDate && !DAY_PATTERN.test(input.startDate))
      throw cleaningErrors.invalid('startDate', 'invalid_type');
    const now = this.deps.clock.now();
    return runIdempotent<AcceptedQuote>({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'quote.accept',
      key: input.idempotencyKey,
      body: { quoteId: input.quoteId, termsVersion: input.termsVersion, startDate: input.startDate ?? null },
      at: now,
      replay: async (response) => {
        const { record, quote } = await this.get(input.quoteId);
        const program = response.program as unknown as NewProgram;
        return { record, quote, program: { ...program, number: record.programNumber } };
      },
      run: async (stub) => {
        const { record, quote } = await ownedCaseByQuote(this.deps, customer, input.quoteId);
        if (input.termsVersion && input.termsVersion !== quote.termsVersion) {
          throw cleaningErrors.invalid('termsVersion', 'out_of_range');
        }
        const [settings, standing] = await Promise.all([
          this.deps.caseSettings.caseSettings(),
          customer.organizationId
            ? this.deps.cases.organizationStanding(customer.organizationId)
            : Promise.resolve(null),
        ]);
        const accepted = decide(() =>
          acceptQuote({
            quote,
            requestStatus: effectiveStatus(record, now),
            organization:
              customer.organizationId && standing
                ? {
                    role: customer.role ?? 'org_viewer',
                    suspended: standing.suspended,
                    unpaidInvoices: standing.unpaidInvoices,
                    unpaidInvoicesSuspension: settings.unpaidInvoicesSuspension,
                  }
                : null,
            fees: record.fees,
            startDate: input.startDate ?? null,
            ...(input.startDate
              ? { sessionStarts: shiftedStarts(quote.sessionStarts, input.startDate) }
              : {}),
            firstSessionLeadHours: settings.firstSessionLeadHours,
            userId: customer.userId,
            now,
          }),
        );
        const programId = this.deps.ids.next();
        const program: NewProgram = {
          id: programId,
          requestId: record.request.id,
          quoteId: quote.id,
          owner: record.request.owner,
          payerKind: accepted.program.payerKind,
          placeId: record.request.placeId,
          communeKey: record.request.communeKey,
          sessionPrice: quote.sessionPrice,
          teamSize: quote.teamSize,
          durationMinutes: quote.durationMinutes,
          schedulePlan: quote.schedulePlan,
          visitFeeToDeduct: accepted.program.visitFeeDeduction,
          createdAt: now,
          sessions: accepted.program.sessions.map((session) => ({
            id: this.deps.ids.next(),
            rank: session.rank,
            scheduledStart: session.scheduledStart,
            scheduledEnd: new Date(session.scheduledStart.getTime() + quote.durationMinutes * 60_000),
            price: session.price,
            visitFeeDeducted: session.visitFeeDeduction,
          })),
        };
        const acceptedQuote: QuoteRecord = { ...quote, ...accepted.quote };
        const next: CaseRecord = {
          ...record,
          request: { ...record.request, status: accepted.requestStatus, updatedAt: now },
          fees: accepted.fees,
          quotes: record.quotes.map((item) => (item.id === quote.id ? acceptedQuote : item)),
          programId,
          programNumber: null,
          programStatus: 'confirmed',
        };
        const names = await catalogNames(
          this.deps,
          record.request.placeTypeId,
          record.request.cleaningTypeIds,
        );
        const party = caseParty(record.request);
        const sessions = program.sessions;
        let programNumber: string | null = null;
        const saved = await saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.quote.accepted',
                payload: {
                  ...party,
                  quoteId: quote.id,
                  programId,
                  acceptedBy: customer.userId,
                  total: money(accepted.program.total),
                  acceptedAt: iso(now),
                },
              },
            ],
            audit: [
              audit(customer.userId, 'quote.accepted', 'quote', quote.id, now, {
                programId,
                total: accepted.program.total,
                visitFeeDeduction: accepted.program.visitFeeDeduction,
              }),
            ],
            idempotency: stub({ program: JSON.parse(JSON.stringify(program)) as Record<string, unknown> }),
          },
          program,
          programEvents: (number) => {
            programNumber = number;
            return [
              {
                type: 'cleaning.program.confirmed',
                payload: {
                  ...party,
                  programId,
                  programNumber: number,
                  quoteId: quote.id,
                  payerKind: program.payerKind,
                  sessionsCount: sessions.length,
                  sessionPrice: money(program.sessionPrice),
                  total: money(accepted.program.total),
                  visitFeeDeduction: money(accepted.program.visitFeeDeduction),
                  firstSessionAt: iso(sessions[0]!.scheduledStart),
                  lastSessionAt: iso(sessions.at(-1)!.scheduledStart),
                  confirmedAt: iso(now),
                  ...names,
                },
              },
            ];
          },
        });
        return { record: saved, quote: acceptedQuote, program: { ...program, number: programNumber } };
      },
    });
  }

  /** UC-NT-09 — Refuser un devis (R-AC-03) : dossier clos, frais de visite conservés. */
  async decline(input: {
    quoteId: string;
    idempotencyKey: string;
    reasonCode?: string | undefined;
    comment?: string | undefined;
  }) {
    const customer = currentCustomer();
    const comment = text(input.comment, 'comment');
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'quote.decline',
      key: input.idempotencyKey,
      body: { quoteId: input.quoteId, reasonCode: input.reasonCode ?? null, comment },
      at: now,
      replay: async () => this.get(input.quoteId),
      run: async (stub) => {
        const { record, quote } = await ownedCaseByQuote(this.deps, customer, input.quoteId);
        const declined = decide(() =>
          declineQuote({
            quote,
            requestStatus: effectiveStatus(record, now),
            role: customer.role,
            reasonCode: input.reasonCode ?? null,
            comment,
            fees: record.fees,
            userId: customer.userId,
            now,
          }),
        );
        const declinedQuote: QuoteRecord = { ...quote, ...declined.quote };
        const next: CaseRecord = {
          ...record,
          request: { ...record.request, status: declined.requestStatus, closedAt: now, updatedAt: now },
          fees: declined.fees,
          quotes: record.quotes.map((item) => (item.id === quote.id ? declinedQuote : item)),
        };
        const saved = await saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.quote.declined',
                payload: {
                  ...caseParty(record.request),
                  quoteId: quote.id,
                  declinedBy: customer.userId,
                  reasonCode:
                    (declinedQuote.declineReasonCode as
                      'price' | 'schedule' | 'no_longer_needed' | 'other' | null) ?? null,
                  declinedAt: iso(now),
                  communeKey: record.request.communeKey,
                },
              },
            ],
            audit: [audit(customer.userId, 'quote.declined', 'quote', quote.id, now)],
            idempotency: stub({ quoteId: quote.id }),
          },
        });
        return { record: saved, quote: quoteById(saved, quote.id) };
      },
    });
  }

  /** R-AC-02 — Transmettre un devis aux administrateurs de l'organisation, rejouable sans effet. */
  async forward(quoteId: string) {
    const customer = currentCustomer();
    const now = this.deps.clock.now();
    const { record, quote } = await ownedCaseByQuote(this.deps, customer, quoteId);
    decide(() => forwardQuote({ quote, role: customer.role, now }));
    await saveCase(this.deps, record, record.request.version, {
      changes: {
        events: [
          {
            type: 'cleaning.quote.forwarded',
            payload: {
              ...caseParty(record.request),
              quoteId: quote.id,
              forwardedBy: customer.userId,
              forwardedAt: iso(now),
            },
          },
        ],
        audit: [audit(customer.userId, 'quote.forwarded', 'quote', quote.id, now)],
      },
    });
    return { record, quote };
  }
}
