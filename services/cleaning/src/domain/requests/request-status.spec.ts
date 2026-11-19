/**
 * Statuts de la demande (partie 15.2), statut lu d'après l'heure et plafond des demandes ouvertes.
 *
 * Matrice règle → test :
 * - 15.2 (demande), toute transition listée            → « transitions autorisées de 15.2 »
 * - 15.2, toute autre transition                        → « refuse toute autre transition »
 * - 15.2, visit_missed → visit_to_schedule supprimée    → « n'a plus de retour direct… »
 * - 15.2 / RV-14, statut lu d'après l'heure             → « statut effectif »
 * - R-DM-04 / RV-14, demandes ouvertes et plafond       → « demandes ouvertes (R-DM-04) »
 * - R-FV-03, R-DV-04, bornes exactes                    → « échéances : borne exacte »
 * - fuseau Africa/Porto-Novo                            → « jour local »
 */
import { DomainRuleError } from './errors';
import {
  assertOpenRequestLimit,
  assertRequestTransition,
  canTransitionRequest,
  countOpenRequests,
  effectiveRequestStatus,
  isClosedRequestStatus,
  isOpenRequest,
  REQUEST_STATUSES,
  type RequestStatus,
} from './request-status';
import { addDays, addHours, isPastDeadline, localDay, TIME_ZONE } from './time';

const at = (iso: string) => new Date(iso);
/** 10 h à Porto-Novo (UTC+1, sans heure d'été). */
const NOW = at('2026-11-20T09:00:00Z');

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

describe('jour local et échéances', () => {
  it('travaille dans le fuseau de Porto-Novo', () => {
    expect(TIME_ZONE).toBe('Africa/Porto-Novo');
    // 23 h 30 UTC le 20 = 0 h 30 le 21 à Porto-Novo.
    expect(localDay(at('2026-11-20T23:30:00Z'))).toBe('2026-11-21');
    expect(localDay(at('2026-11-20T22:59:59Z'))).toBe('2026-11-20');
  });

  it('ajoute des heures et des jours de 24 h', () => {
    expect(addHours(NOW, 72).toISOString()).toBe('2026-11-23T09:00:00.000Z');
    expect(addDays(NOW, 15).toISOString()).toBe('2026-12-05T09:00:00.000Z');
  });

  it('borne exacte : l’échéance est atteinte à l’instant même', () => {
    const deadline = addHours(NOW, 72);
    expect(isPastDeadline(deadline, new Date(deadline.getTime() - 1))).toBe(false);
    expect(isPastDeadline(deadline, deadline)).toBe(true);
  });
});

describe('transitions autorisées de 15.2', () => {
  const allowed: Array<[RequestStatus, RequestStatus]> = [
    ['awaiting_visit_fee', 'visit_to_schedule'],
    ['visit_to_schedule', 'visit_scheduled'],
    ['visit_scheduled', 'visit_done'],
    ['visit_done', 'quote_sent'],
    ['quote_sent', 'accepted'],
    ['quote_sent', 'declined'],
    ['quote_sent', 'expired'],
    ['visit_scheduled', 'visit_to_schedule'],
    ['visit_scheduled', 'visit_missed'],
    ['visit_missed', 'awaiting_visit_fee'],
    ['visit_done', 'visit_to_schedule'],
    ['quote_sent', 'visit_to_schedule'],
    ['expired', 'visit_done'],
  ];

  it.each(allowed)('%s → %s', (from, to) => {
    expect(canTransitionRequest(from, to)).toBe(true);
    expect(() => assertRequestTransition(from, to)).not.toThrow();
  });

  it.each([
    'awaiting_visit_fee',
    'visit_to_schedule',
    'visit_scheduled',
    'visit_done',
    'quote_sent',
  ] as const)('annulation et refus par KSP possibles avant l’acceptation : %s', (from) => {
    expect(canTransitionRequest(from, 'cancelled')).toBe(true);
    expect(canTransitionRequest(from, 'rejected')).toBe(true);
  });
});

describe('refuse toute autre transition', () => {
  it('répond CLEANING_INVALID_TRANSITION avec from et to', () => {
    const error = thrown(() => assertRequestTransition('accepted', 'cancelled'));
    expect(error.code).toBe('CLEANING_INVALID_TRANSITION');
    expect(error.details).toEqual({ from: 'accepted', to: 'cancelled' });
  });

  it('les statuts clos sont terminaux, sauf la réactivation d’un devis expiré', () => {
    for (const from of ['accepted', 'declined', 'cancelled', 'rejected'] as const) {
      for (const to of REQUEST_STATUSES) expect(canTransitionRequest(from, to)).toBe(false);
    }
    expect(REQUEST_STATUSES.filter((to) => canTransitionRequest('expired', to))).toEqual(['visit_done']);
  });

  it('n’a plus de retour direct de visit_missed vers visit_to_schedule', () => {
    expect(canTransitionRequest('visit_missed', 'visit_to_schedule')).toBe(false);
    expect(REQUEST_STATUSES.filter((to) => canTransitionRequest('visit_missed', to))).toEqual([
      'awaiting_visit_fee',
    ]);
  });

  it('pas de saut d’étape ni de transition vers soi-même', () => {
    expect(canTransitionRequest('awaiting_visit_fee', 'visit_scheduled')).toBe(false);
    expect(canTransitionRequest('visit_done', 'accepted')).toBe(false);
    expect(canTransitionRequest('quote_sent', 'quote_sent')).toBe(false);
    expect(canTransitionRequest('visit_done', 'declined')).toBe(false);
  });

  it('distingue les statuts clos', () => {
    expect(isClosedRequestStatus('declined')).toBe(true);
    expect(isClosedRequestStatus('expired')).toBe(true);
    expect(isClosedRequestStatus('accepted')).toBe(false);
    expect(isClosedRequestStatus('quote_sent')).toBe(false);
  });
});

describe('statut effectif', () => {
  const validUntil = at('2026-12-05T09:00:00Z');
  const dueAt = at('2026-11-23T09:00:00Z');

  it('devis envoyé encore valable : quote_sent ; à la date de validité : expired', () => {
    const request = { status: 'quote_sent' as const, sentQuoteValidUntil: validUntil };
    expect(effectiveRequestStatus(request, new Date(validUntil.getTime() - 1))).toBe('quote_sent');
    expect(effectiveRequestStatus(request, validUntil)).toBe('expired');
  });

  it('frais impayés : awaiting_visit_fee jusqu’à l’échéance, puis cancelled', () => {
    const request = { status: 'awaiting_visit_fee' as const, pendingVisitFeeDueAt: dueAt };
    expect(effectiveRequestStatus(request, new Date(dueAt.getTime() - 1))).toBe('awaiting_visit_fee');
    expect(effectiveRequestStatus(request, dueAt)).toBe('cancelled');
  });

  it('les autres statuts ne dépendent pas de l’heure', () => {
    expect(
      effectiveRequestStatus({ status: 'visit_done', sentQuoteValidUntil: validUntil }, validUntil),
    ).toBe('visit_done');
    expect(effectiveRequestStatus({ status: 'quote_sent' }, validUntil)).toBe('quote_sent');
    expect(effectiveRequestStatus({ status: 'awaiting_visit_fee', pendingVisitFeeDueAt: null }, dueAt)).toBe(
      'awaiting_visit_fee',
    );
  });
});

describe('demandes ouvertes (R-DM-04)', () => {
  const validUntil = at('2026-12-05T09:00:00Z');

  it('compte les statuts ouverts, visit_missed compris', () => {
    for (const status of [
      'awaiting_visit_fee',
      'visit_to_schedule',
      'visit_scheduled',
      'visit_missed',
      'visit_done',
    ] as const) {
      expect(isOpenRequest({ status }, NOW)).toBe(true);
    }
    for (const status of ['accepted', 'declined', 'expired', 'cancelled', 'rejected'] as const) {
      expect(isOpenRequest({ status }, NOW)).toBe(false);
    }
  });

  it('un devis périmé n’est plus compté comme ouvert', () => {
    const request = { status: 'quote_sent' as const, sentQuoteValidUntil: validUntil };
    expect(isOpenRequest(request, new Date(validUntil.getTime() - 1))).toBe(true);
    expect(isOpenRequest(request, validUntil)).toBe(false);
  });

  it('compte les demandes ouvertes du titulaire', () => {
    const requests = [
      { status: 'visit_done' as const },
      { status: 'quote_sent' as const, sentQuoteValidUntil: validUntil },
      { status: 'awaiting_visit_fee' as const, pendingVisitFeeDueAt: addHours(NOW, -1) },
      { status: 'accepted' as const },
    ];
    expect(countOpenRequests(requests, NOW)).toBe(2);
  });

  it('plafond : 4 ouvertes sur 5 passent, 5 sur 5 sont refusées', () => {
    expect(() => assertOpenRequestLimit(4, 5)).not.toThrow();
    const error = thrown(() => assertOpenRequestLimit(5, 5));
    expect(error.code).toBe('CLEANING_TOO_MANY_OPEN_REQUESTS');
    expect(error.details).toEqual({ maximum: 5 });
  });
});
