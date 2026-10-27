import {
  DEFAULT_TEAM_SIZE,
  normalizeCommune,
  pricingProblems,
  recommendedTeamSize,
  type ServiceDefinition,
} from './catalog';
import {
  canTransitionIntervention,
  deriveMissionStatus,
  type Intervention,
  isCancellableByCustomer,
  nextStart,
  remainingToSchedule,
} from './mission';
import { applyCoefficient, percentOf, roundToStep } from './money';
import { newPaymentState, paymentRefusal, paymentStatus, type PaymentState } from './payment';
import { buildQuote, findProposedSlot, isQuoteExpired, isValidLine } from './quote';
import { canSendQuote, canTransitionRequest, effectiveRequestStatus } from './quote-request';
import { isValidRecurrence, plannedInterventions } from './recurrence';
import { conflictingAgents, isFreeCancellation, overlaps, respectsLeadTime, slotFrom } from './schedule';
import { INITIAL_ZONES, isCovered, isValidZoneCode, zoneCode } from './zone';
import { DEFAULT_SETTINGS, settingsProblems } from './settings';
import { priceRange, simulate, unknownOptions } from './simulator';

const NOW = new Date('2026-10-23T08:00:00Z');
const at = (iso: string) => new Date(iso);

function service(pricing: Partial<ServiceDefinition['pricing']> = {}): ServiceDefinition {
  return {
    code: 'home_cleaning',
    name: 'Nettoyage à domicile',
    description: '',
    unit: 'room',
    active: true,
    pricing: {
      version: 1,
      unitPrice: 5000,
      minimumPrice: 15000,
      options: [
        { code: 'windows', label: 'Vitres', price: 4000 },
        { code: 'weekend', label: 'Week-end', price: null },
      ],
      communeCoefficients: { 'abomey-calavi': 11000 },
      defaultCoefficientBp: 10000,
      teamSize: { unitsPerAgent: 3, minAgents: 1, maxAgents: 6 },
      checklist: [],
      updatedBy: 'admin',
      updatedAt: NOW,
      ...pricing,
    },
  };
}

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

describe('simulateur', () => {
  it('quantité × prix unitaire + options, multiplié par le coefficient de la commune', () => {
    const result = simulate(service(), { quantity: 6, options: ['windows'], commune: 'Abomey-Calavi' });
    expect(result).toMatchObject({
      priced: true,
      computedPrice: 37_400,
      coefficientBp: 11_000,
      minimumApplied: false,
      breakdown: [
        { label: 'Nettoyage à domicile', quantity: 6, unitPrice: 5000, amount: 30_000 },
        { label: 'Vitres', quantity: 1, unitPrice: 4000, amount: 4000 },
      ],
    });
  });

  it('fourchette −10 % / +15 % arrondie à 500 FCFA', () => {
    expect(priceRange(37_400)).toEqual({ low: 33_500, high: 43_000 });
    const result = simulate(service(), { quantity: 6, options: ['windows'], commune: 'Abomey-Calavi' });
    expect(result).toMatchObject({ low: 33_500, high: 43_000 });
  });

  it('applique le minimum de commande', () => {
    const result = simulate(service(), { quantity: 1, options: [], commune: 'Cotonou' });
    expect(result).toMatchObject({ priced: true, computedPrice: 15_000, minimumApplied: true });
  });

  it('commune inconnue : coefficient par défaut', () => {
    const result = simulate(service(), { quantity: 4, options: [], commune: 'Ouidah' });
    expect(result).toMatchObject({ computedPrice: 20_000, coefficientBp: 10_000 });
  });

  it('prestation sans prix : réponse propre, sans montant', () => {
    expect(simulate(service({ unitPrice: null }), { quantity: 4, options: [], commune: 'Cotonou' })).toEqual({
      priced: false,
      reason: 'price_not_set',
      recommendedTeamSize: 2,
    });
  });

  it('option choisie sans prix : pas de montant', () => {
    expect(simulate(service(), { quantity: 4, options: ['weekend'], commune: 'Cotonou' })).toMatchObject({
      priced: false,
      reason: 'option_price_not_set',
    });
  });

  it('repère les options inconnues de la grille', () => {
    expect(unknownOptions(service(), ['windows', 'pool'])).toEqual(['pool']);
  });

  it('normalise le nom des communes', () => {
    expect(normalizeCommune('  Abomey Calavi ')).toBe('abomey-calavi');
    expect(normalizeCommune('Sèmè-Podji')).toBe('seme-podji');
  });
});

describe('taille d’équipe', () => {
  const rule = { unitsPerAgent: 3, minAgents: 1, maxAgents: 6 };

  it('dépend du nombre de pièces, dans les bornes', () => {
    expect(recommendedTeamSize(rule, 1)).toBe(1);
    expect(recommendedTeamSize(rule, 7)).toBe(3);
    expect(recommendedTeamSize(rule, 100)).toBe(6);
  });

  it('suit la demande du client quand il la précise', () => {
    expect(recommendedTeamSize(rule, 7, 5)).toBe(5);
    expect(recommendedTeamSize(rule, 7, 50)).toBe(6);
  });
});

describe('grille et réglages', () => {
  it('refuse les montants non entiers, coefficients et équipes incohérents', () => {
    const { pricing } = service();
    expect(pricingProblems(pricing)).toEqual([]);
    expect(
      pricingProblems({
        ...pricing,
        unitPrice: 12.5,
        defaultCoefficientBp: 0,
        teamSize: { ...DEFAULT_TEAM_SIZE, minAgents: 5, maxAgents: 2 },
      }),
    ).toEqual(['unitPrice', 'defaultCoefficientBp', 'teamSize']);
  });

  it('valide les réglages de la partie 4', () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, depositPercent: 120 })).toEqual(['depositPercent']);
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
});
