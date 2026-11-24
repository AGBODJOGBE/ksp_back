/**
 * Critère du lot C (partie 18), dans le domaine seul : « parcours complet jusqu'à un programme
 * confirmé, avec un écart déclaré / constaté affiché au client et les frais de visite déduits ».
 *
 * Matrice règle → test :
 * - R-DM-04, R-FV-02, R-FV-03 envoi puis paiement des frais       → étape 1
 * - R-VI-01, R-VI-04 visite planifiée, arrivée, constat à l'heure → étape 2
 * - 7.4, R-CS-02 écart 120 m² déclarés / 150 m² constatés         → étape 3
 * - R-DV-01, R-DV-07, R-FV-05, R-CS-03 devis composé, envoyé, figé → étape 4
 * - R-AC-01, R-FV-05 acceptation, programme confirmé, déduction    → étape 5
 * Les prix (18 000 et 23 400 FCFA, effet de + 5 400 FCFA) sont ceux que fournira le domaine du prix.
 */
import { requestReactivation, submitRequest } from '../requests/request-lifecycle';
import { effectiveRequestStatus, type RequestStatus } from '../requests/request-status';
import { localDay } from '../requests/time';
import { deductibleVisitFeeAmount, payVisitFee } from '../requests/visit-fee';
import {
  buildComparison,
  lockRevision,
  prefillObserved,
  quoteBaseSessionPrice,
  saveRetained,
} from '../visits/observation';
import { completeVisit, markArrived, observationTime, planVisit } from '../visits/visit';
import { acceptQuote } from './acceptance';
import { composeQuote, type PricedLine, sendQuote } from './quote';

const at = (iso: string) => new Date(iso);

describe('critère du lot C : de la demande au programme confirmé', () => {
  it('écart déclaré / constaté montré au client, frais de visite déduits du premier paiement', () => {
    const trail: RequestStatus[] = [];

    // Étape 1 — demande envoyée le 20 novembre à 10 h (Porto-Novo), solde insuffisant, puis payée.
    const submittedAt = at('2026-11-20T09:00:00Z');
    const declared = { values: { area: 120, soil: 'normal' }, cleaningTypeIds: ['floor'] };
    const submitted = submitRequest({
      openCount: 4,
      maxOpenRequests: 5,
      organizationSuspended: false,
      slots: [{ start: at('2026-11-21T09:00:00Z'), end: at('2026-11-21T12:00:00Z') }],
      minVisitLeadHours: 24,
      feeId: 'fee-1',
      feeAmount: 5_000,
      paymentHours: 72,
      walletDebited: false,
      now: submittedAt,
    });
    trail.push(submitted.status);
    const paid = payVisitFee(submitted.fee, submitted.status, at('2026-11-20T15:00:00Z'));
    trail.push(paid.requestStatus);
    let fees = [paid.fee];

    // Étape 2 — visite le 21 à 10 h, au plus tôt 24 h après la demande ; constat à l'heure.
    const planned = planVisit({
      id: 'visit-1',
      attempt: 1,
      requestStatus: paid.requestStatus,
      fees,
      start: at('2026-11-21T09:00:00Z'),
      durationMinutes: 60,
      requestCreatedAt: submittedAt,
      minLeadHours: 24,
      now: at('2026-11-20T16:00:00Z'),
    });
    trail.push(planned.requestStatus);
    const onSite = markArrived(planned.visit, at('2026-11-21T08:55:00Z'));
    const observed = { ...prefillObserved(declared), area: 150 };
    expect(observationTime(onSite, at('2026-11-21T09:00:00Z'))).toEqual(at('2026-11-21T09:00:00Z'));
    const done = completeVisit(onSite, at('2026-11-21T09:45:00Z'));
    trail.push(done.requestStatus);

    // Étape 3 — retenu = constaté (aucun motif exigé) ; tableau des écarts pour le client.
    const retained = saveRetained({
      requestStatus: done.requestStatus,
      revisions: [],
      currentVisitId: 'visit-1',
      observed,
      declaredCleaningTypeIds: declared.cleaningTypeIds,
      input: { values: observed, cleaningTypeIds: ['floor'], reasons: [], sessionPrice: 23_400 },
      authorId: 'sup-1',
      now: at('2026-11-21T14:00:00Z'),
    });
    const comparison = buildComparison({
      declared: { ...declared, sessionPrice: 18_000 },
      observed,
      retained: { ...retained.saved },
      priceEffects: { area: 5_400 },
    });
    expect(comparison.confirmed).toBe(false);
    expect(comparison.rows[0]).toEqual({
      parameterCode: 'area',
      declared: 120,
      observed: 150,
      retained: 150,
      changed: true,
      delta: 30,
      priceEffect: 5_400,
    });

    // Étape 4 — devis composé depuis le retenu, frais déductibles, envoyé : la révision 1 est figée.
    const sentAt = at('2026-11-21T15:00:00Z');
    const lines: PricedLine[] = [
      {
        offerId: 'o-floor',
        cleaningTypeId: 'floor',
        name: 'Sol',
        quantity: 150,
        unit: 'm²',
        unitPrice: 156,
        amount: 23_400,
        kind: 'offer',
      },
    ];
    const draft = composeQuote({
      id: 'quote-1',
      requestId: 'req-1',
      version: 1,
      requestStatus: done.requestStatus,
      retainedRevision: retained.saved.revision,
      lines,
      basePrice: quoteBaseSessionPrice(comparison),
      adjustments: [],
      sessionStarts: [at('2026-11-24T08:00:00Z'), at('2026-12-01T08:00:00Z')],
      teamSize: 2,
      durationMinutes: 180,
      paymentTerms: 'per_session',
      termsVersion: 'cg-2026-11',
      deductibleVisitFee: deductibleVisitFeeAmount(fees, true),
      discountApprovalThresholdPercent: 20,
      firstSessionLeadHours: 48,
      createdBy: 'sup-1',
      now: sentAt,
    });
    const sent = sendQuote({
      quote: draft,
      requestStatus: done.requestStatus,
      previous: null,
      validityDays: 15,
      firstSessionLeadHours: 48,
      now: sentAt,
    });
    const revisions = lockRevision(retained.revisions, sent.quote.retainedRevision, sentAt);
    trail.push(sent.requestStatus);
    expect(revisions[0]?.lockedAt).toEqual(sentAt);
    expect(sent.quote).toMatchObject({ sessionPrice: 23_400, total: 46_800, visitFeeDeduction: 5_000 });
    expect(localDay(sent.quote.validUntil as Date)).toBe('2026-12-06');

    // Le dossier est ouvert et ne demande pas de réactivation tant que le devis est valable.
    const timeline = { status: sent.requestStatus, sentQuoteValidUntil: sent.quote.validUntil };
    expect(effectiveRequestStatus(timeline, at('2026-11-21T22:00:00Z'))).toBe('quote_sent');
    expect(() => requestReactivation(timeline, null, 'client-1', at('2026-11-21T22:00:00Z'))).toThrow();

    // Étape 5 — acceptation le 21 à 23 h (Porto-Novo) : programme confirmé, frais déduits.
    const accepted = acceptQuote({
      quote: sent.quote,
      requestStatus: sent.requestStatus,
      organization: null,
      fees,
      firstSessionLeadHours: 48,
      userId: 'client-1',
      now: at('2026-11-21T22:00:00Z'),
    });
    trail.push(accepted.requestStatus);
    fees = accepted.fees;

    expect(trail).toEqual([
      'awaiting_visit_fee',
      'visit_to_schedule',
      'visit_scheduled',
      'visit_done',
      'quote_sent',
      'accepted',
    ]);
    expect(fees[0]?.status).toBe('deducted');
    expect(accepted.program.status).toBe('confirmed');
    expect(accepted.program.sessions.map((session) => [session.price, session.visitFeeDeduction])).toEqual([
      [23_400, 5_000],
      [23_400, 0],
    ]);
    const firstPayment =
      accepted.program.sessions[0]!.price - accepted.program.sessions[0]!.visitFeeDeduction;
    expect(firstPayment).toBe(18_400);
  });
});
