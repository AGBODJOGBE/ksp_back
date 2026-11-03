import { normalizeCommune } from './catalog';
import {
  canTransitionIntervention,
  deriveMissionStatus,
  type Intervention,
  isCancellableByCustomer,
  nextStart,
  remainingToSchedule,
} from './mission';
import { applyCoefficient, percentOf, roundToStep } from './money';
import {
  expectedDeposit,
  isValidPlan,
  newPaymentState,
  onlinePaymentIds,
  paymentRefusal,
  paymentStatus,
  type PaymentState,
  remainingDue,
} from './payment';
import { buildQuote, findProposedSlot, isQuoteExpired, isValidLine } from './quote';
import { canSendQuote, canTransitionRequest, effectiveRequestStatus } from './quote-request';
import { isValidRecurrence, plannedInterventions } from './recurrence';
import { conflictingAgents, isFreeCancellation, overlaps, respectsLeadTime, slotFrom } from './schedule';
import { INITIAL_ZONES, isCovered, isValidZoneCode, zoneCode } from './zone';
import { DEFAULT_SETTINGS, mergeSettings, settingsProblems } from './settings';

const NOW = new Date('2026-10-23T08:00:00Z');
const at = (iso: string) => new Date(iso);

describe('montants', () => {
  it('arrondit au multiple de 500 le plus proche', () => {
    expect(roundToStep(40_249, 500)).toBe(40_000);
    expect(roundToStep(40_250, 500)).toBe(40_500);
  });

  it('applique pourcentages et coefficients en entiers', () => {
    expect(percentOf(45_000, 30)).toBe(13_500);
    expect(applyCoefficient(45_000, 11_000)).toBe(49_500);
    expect(applyCoefficient(333, 10_500)).toBe(350);
  });
});

describe('communes', () => {
  it('normalise le nom des communes', () => {
    expect(normalizeCommune('  Abomey Calavi ')).toBe('abomey-calavi');
    expect(normalizeCommune('Sèmè-Podji')).toBe('seme-podji');
  });
});

describe('réglages', () => {
  it('valide les réglages de la partie 4', () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, depositPercent: 120 })).toEqual(['depositPercent']);
  });

  it('ignore le seuil de visite à l’écriture (déprécié, ADR-033)', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, visitThresholdSquareMeters: 0 });
    expect(merged.visitThresholdSquareMeters).toBe(DEFAULT_SETTINGS.visitThresholdSquareMeters);
  });
});

describe('demande de devis', () => {
  it('suit les transitions prévues, refuse les autres', () => {
    expect(canTransitionRequest('received', 'visit_scheduled')).toBe(true);
    expect(canTransitionRequest('quote_sent', 'accepted')).toBe(true);
    expect(canTransitionRequest('received', 'accepted')).toBe(false);
    expect(canTransitionRequest('accepted', 'cancelled')).toBe(false);
    expect(canTransitionRequest('declined', 'quote_sent')).toBe(false);
  });

  it('visite des lieux réalisée obligatoire avant tout devis, pour toutes les demandes', () => {
    const visit = (status: 'scheduled' | 'completed' | 'cancelled') =>
      ({ visit: { status } }) as Parameters<typeof canSendQuote>[0];
    expect(canSendQuote({ visit: null })).toBe(false);
    expect(canSendQuote(visit('scheduled'))).toBe(false);
    expect(canSendQuote(visit('cancelled'))).toBe(false);
    expect(canSendQuote(visit('completed'))).toBe(true);
    expect(canTransitionRequest('quote_sent', 'visit_scheduled')).toBe(true);
  });

  it('zones desservies : clé normalisée comme les coefficients, zone désactivée non desservie', () => {
    const zones = INITIAL_ZONES.map((commune) => ({
      code: zoneCode(commune),
      commune,
      active: commune !== 'Porto-Novo',
      updatedBy: null,
      updatedAt: null,
    }));
    expect(zones.map((zone) => zone.code)).toEqual(['cotonou', 'porto-novo', 'abomey-calavi']);
    expect(isCovered(zones, 'Abomey Calavi')).toBe(true);
    expect(isCovered(zones, ' COTONOU ')).toBe(true);
    expect(isCovered(zones, 'Porto-Novo')).toBe(false);
    expect(isCovered(zones, 'Parakou')).toBe(false);
    expect(isValidZoneCode(zoneCode('Sèmè-Podji'))).toBe(true);
    expect(isValidZoneCode(zoneCode('!!'))).toBe(false);
  });

  it('un devis envoyé dont la validité est dépassée est affiché expiré', () => {
    const quote = { validUntil: at('2026-10-22T00:00:00Z') } as never;
    expect(effectiveRequestStatus({ status: 'quote_sent', quote }, NOW)).toBe('expired');
    expect(effectiveRequestStatus({ status: 'accepted', quote }, NOW)).toBe('accepted');
  });
});

describe('devis', () => {
  const slot = slotFrom(at('2026-10-30T08:00:00Z'), 180);
  const draft = {
    id: 'q1',
    lines: [{ label: 'Bureaux', quantity: 200, unitPrice: 250, amount: 50_000 }],
    proposedSlots: [slot],
    validityDays: 15,
    depositPercent: 30,
    recurrence: null,
    teamSize: 2,
    durationMinutes: 180,
    now: NOW,
  };

  it('calcule total, acompte et validité', () => {
    const quote = buildQuote(draft);
    expect(quote).toMatchObject({
      subtotal: 50_000,
      interventionCount: 1,
      total: 50_000,
      depositAmount: 15_000,
    });
    expect(quote.validUntil.toISOString()).toBe('2026-11-07T08:00:00.000Z');
    expect(isQuoteExpired(quote, at('2026-11-07T07:59:59Z'))).toBe(false);
    expect(isQuoteExpired(quote, at('2026-11-07T08:00:00Z'))).toBe(true);
  });

  it('contrat récurrent : prix d’un passage × nombre de passages', () => {
    const quote = buildQuote({
      ...draft,
      recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
    });
    expect(quote).toMatchObject({ interventionCount: 13, total: 650_000, depositAmount: 195_000 });
  });

  it('vérifie chaque ligne et retrouve le créneau choisi', () => {
    expect(isValidLine({ label: 'x', quantity: 2, unitPrice: 100, amount: 201 })).toBe(false);
    expect(isValidLine({ label: 'x', quantity: 2, unitPrice: 100.5, amount: 201 })).toBe(false);
    const quote = buildQuote(draft);
    expect(findProposedSlot(quote, at('2026-10-30T08:00:00Z'))).toEqual(slot);
    expect(findProposedSlot(quote, at('2026-10-30T09:00:00Z'))).toBeNull();
  });
});

describe('récurrence', () => {
  it('compte les passages prévus', () => {
    expect(plannedInterventions(null)).toBe(1);
    expect(plannedInterventions({ period: 'week', visitsPerPeriod: 2, durationMonths: 6 })).toBe(52);
    expect(plannedInterventions({ period: 'month', visitsPerPeriod: 4, durationMonths: 12 })).toBe(48);
  });

  it('refuse les contrats incohérents', () => {
    expect(isValidRecurrence({ period: 'week', visitsPerPeriod: 8, durationMonths: 1 })).toBe(false);
    expect(isValidRecurrence({ period: 'month', visitsPerPeriod: 1, durationMonths: 0 })).toBe(false);
    expect(isValidRecurrence({ period: 'month', visitsPerPeriod: 2, durationMonths: 12 })).toBe(true);
  });
});

describe('créneaux et conflits', () => {
  const slot = { start: at('2026-10-30T08:00:00Z'), end: at('2026-10-30T11:00:00Z') };

  it('détecte les chevauchements (fin exclue)', () => {
    expect(overlaps(slot, { start: at('2026-10-30T10:00:00Z'), end: at('2026-10-30T12:00:00Z') })).toBe(true);
    expect(overlaps(slot, { start: at('2026-10-30T11:00:00Z'), end: at('2026-10-30T12:00:00Z') })).toBe(
      false,
    );
  });

  it('liste les agents déjà pris', () => {
    const busy = [
      { agentId: 'a1', slot: { start: at('2026-10-30T09:00:00Z'), end: at('2026-10-30T10:00:00Z') } },
      { agentId: 'a2', slot: { start: at('2026-10-31T09:00:00Z'), end: at('2026-10-31T10:00:00Z') } },
    ];
    expect(conflictingAgents(['a1', 'a2', 'a1'], slot, busy)).toEqual(['a1']);
  });

  it('délai minimum et annulation sans frais', () => {
    expect(respectsLeadTime(at('2026-10-25T08:00:00Z'), NOW, 48)).toBe(true);
    expect(respectsLeadTime(at('2026-10-25T07:59:00Z'), NOW, 48)).toBe(false);
    expect(isFreeCancellation(at('2026-10-24T08:00:00Z'), NOW, 24)).toBe(true);
    expect(isFreeCancellation(at('2026-10-24T07:00:00Z'), NOW, 24)).toBe(false);
  });
});

describe('mission et passages', () => {
  const intervention = (status: Intervention['status'], start = '2026-10-30T08:00:00Z'): Intervention => ({
    id: status,
    status,
    scheduledStart: at(start),
    durationMinutes: 120,
    agentIds: ['a1'],
    checklist: [],
    incidentNote: null,
    beforePhotoFileIds: [],
    afterPhotoFileIds: [],
    startedAt: null,
    completedAt: null,
    cancellationCause: null,
    cancelledAt: null,
  });
  const mission = (interventions: Intervention[], plannedInterventions = 1) => ({
    status: 'scheduled' as const,
    interventions,
    plannedInterventions,
    chosenSlot: { start: at('2026-11-02T08:00:00Z'), end: at('2026-11-02T10:00:00Z') },
  });

  it('transitions d’un passage', () => {
    expect(canTransitionIntervention('planned', 'in_progress')).toBe(true);
    expect(canTransitionIntervention('in_progress', 'on_hold')).toBe(true);
    expect(canTransitionIntervention('on_hold', 'in_progress')).toBe(true);
    expect(canTransitionIntervention('planned', 'completed')).toBe(false);
    expect(canTransitionIntervention('completed', 'in_progress')).toBe(false);
  });

  it('déduit l’état de la mission de ses passages', () => {
    expect(deriveMissionStatus(mission([]))).toBe('to_schedule');
    expect(deriveMissionStatus(mission([intervention('planned')]))).toBe('scheduled');
    expect(deriveMissionStatus(mission([intervention('in_progress')]))).toBe('in_progress');
    expect(deriveMissionStatus(mission([intervention('on_hold')]))).toBe('on_hold');
    expect(deriveMissionStatus(mission([intervention('completed')]))).toBe('completed');
    expect(deriveMissionStatus(mission([intervention('completed')], 4))).toBe('to_schedule');
    expect(deriveMissionStatus({ ...mission([]), status: 'cancelled' })).toBe('cancelled');
  });

  it('compte les passages restant à planifier et le prochain début', () => {
    const m = mission([intervention('completed'), intervention('cancelled'), intervention('planned')], 4);
    expect(remainingToSchedule(m)).toBe(2);
    expect(nextStart(m)).toEqual(at('2026-10-30T08:00:00Z'));
    expect(nextStart(mission([]))).toEqual(at('2026-11-02T08:00:00Z'));
  });

  it('le client annule seulement avant le début', () => {
    expect(isCancellableByCustomer({ status: 'scheduled' })).toBe(true);
    expect(isCancellableByCustomer({ status: 'in_progress' })).toBe(false);
  });
});

describe('paiement', () => {
  const record = (amount: number) => ({
    id: String(amount),
    amount,
    method: 'cash' as const,
    reference: null,
    recordedBy: 'sup',
    recordedAt: NOW,
    idempotencyKey: null,
  });

  it('acompte de 30 % : dû, acompte reçu, payé', () => {
    const state = newPaymentState({ option: 'deposit', timing: 'before', method: 'cash' }, 50_000, 30);
    expect(state.depositAmount).toBe(15_000);
    expect(paymentStatus(state)).toBe('due');
    expect(paymentStatus({ ...state, payments: [record(15_000)] })).toBe('deposit_received');
    expect(paymentStatus({ ...state, payments: [record(15_000), record(35_000)] })).toBe('paid');
  });

  it('totalité : pas d’état intermédiaire', () => {
    const state = newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 50_000, 30);
    expect(state.depositAmount).toBe(50_000);
    expect(paymentStatus({ ...state, payments: [record(20_000)] })).toBe('due');
  });

  it('refuse montant invalide, moyen en ligne coché à la main, trop-perçu', () => {
    const state: PaymentState = {
      ...newPaymentState({ option: 'deposit', timing: 'before', method: 'cash' }, 50_000, 30),
      payments: [record(40_000)],
    };
    expect(paymentRefusal(state, 0, 'cash', true)).toBe('amount_invalid');
    expect(paymentRefusal(state, 100.5, 'cash', true)).toBe('amount_invalid');
    expect(paymentRefusal(state, 5000, 'mobile_money_online', true)).toBe('method_not_allowed');
    expect(paymentRefusal(state, 10_001, 'cash', true)).toBe('exceeds_balance');
    expect(paymentRefusal(state, 10_000, 'mobile_money_offline', true)).toBeNull();
  });
  it('reste dû et acompte encore attendu (null s’il n’y en a pas)', () => {
    const deposit = newPaymentState({ option: 'deposit', timing: 'before', method: 'cash' }, 50_000, 30);
    expect([remainingDue(deposit), expectedDeposit(deposit)]).toEqual([50_000, 15_000]);
    const partial = { ...deposit, payments: [record(10_000)] };
    expect([remainingDue(partial), expectedDeposit(partial)]).toEqual([40_000, 5_000]);
    const received = { ...deposit, payments: [record(15_000)] };
    expect([remainingDue(received), expectedDeposit(received)]).toEqual([35_000, null]);
    const overpaid = { ...deposit, payments: [record(60_000)] };
    expect([remainingDue(overpaid), expectedDeposit(overpaid)]).toEqual([0, null]);
    const full = newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 50_000, 30);
    expect([remainingDue(full), expectedDeposit(full)]).toEqual([50_000, null]);
  });

  it('paiements en ligne enregistrés : identifiants du service payment', () => {
    const state = newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 50_000, 30);
    expect(
      onlinePaymentIds({
        ...state,
        payments: [
          { ...record(1_000), idempotencyKey: 'online-p1' },
          { ...record(2_000), idempotencyKey: 'manuel-1' },
          record(3_000),
          { ...record(4_000), idempotencyKey: 'online-p2' },
        ],
      }),
    ).toEqual(['p1', 'p2']);
  });

  it('Mobile Money en ligne : moyen accepté dans le plan choisi à l’acceptation', () => {
    for (const method of ['cash', 'mobile_money_offline', 'mobile_money_online'] as const) {
      expect(isValidPlan({ option: 'deposit', timing: 'before', method })).toBe(true);
    }
    expect(isValidPlan({ option: 'deposit', timing: 'before', method: 'cheque' as never })).toBe(false);
  });
});
