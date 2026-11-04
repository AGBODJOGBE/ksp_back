import { locationRetentionCutoff, withoutPosition } from './location';
import { type QuoteRequest } from './quote-request';
import { openSubmissions, planGroupVisit, selectByTransition } from './request-group';
import { conflictingAgents } from './schedule';

const now = new Date('2026-11-04T10:00:00Z');
const request = (id: string, overrides: Partial<QuoteRequest> = {}) =>
  ({ id, status: 'received', quote: null, visit: null, groupId: 'g1', ...overrides }) as QuoteRequest;

describe('groupes de demandes (ADR-035)', () => {
  it('plafond : une demande seule et un groupe ouvert comptent chacun pour 1', () => {
    expect(
      openSubmissions(
        [
          request('a'),
          request('b'),
          request('c', { groupId: null }),
          request('d', { groupId: 'g2', status: 'cancelled' }),
        ],
        now,
      ),
    ).toBe(2);
  });

  it('refus : une demande acceptée est ignorée, une demande au devis envoyé aussi (règle de la demande seule)', () => {
    const quote = { validUntil: new Date('2026-12-01T00:00:00Z') } as QuoteRequest['quote'];
    const { selected, skipped } = selectByTransition(
      [request('a'), request('b', { status: 'accepted' }), request('c', { status: 'quote_sent', quote })],
      'rejected',
      now,
    );
    expect(selected.map((r) => r.id)).toEqual(['a']);
    expect(skipped.map((s) => [s.requestId, s.reason])).toEqual([
      ['b', 'not_open'],
      ['c', 'transition_not_allowed'],
    ]);
  });

  it('visite commune : visite propre gardée, visite réalisée ignorée, exclusion détachée', () => {
    const visit = (groupVisitId: string | null, status: 'scheduled' | 'completed' = 'scheduled') =>
      ({
        id: 'v',
        status,
        scheduledAt: now,
        agentId: 'x',
        report: null,
        completedAt: null,
        groupVisitId,
      }) as const;
    const plan = planGroupVisit(
      [
        request('a', { status: 'visit_scheduled', visit: visit('gv') }),
        request('b', { status: 'visit_scheduled', visit: visit('gv') }),
        request('c', { status: 'visit_scheduled', visit: visit(null) }),
        request('d', { visit: visit(null, 'completed') }),
        request('e'),
      ],
      new Set(['b']),
      now,
    );
    expect(plan.selected.map((r) => r.id)).toEqual(['a', 'e']);
    expect(plan.detached.map((r) => r.id)).toEqual(['b']);
    expect(plan.skipped.map((s) => [s.requestId, s.reason])).toEqual([
      ['b', 'excluded'],
      ['c', 'own_visit'],
      ['d', 'visit_completed'],
    ]);
  });

  it('conflits : passages du même groupe ignorés, autres groupes et indisponibilités contrôlés', () => {
    const slot = { start: new Date('2026-11-10T08:00:00Z'), end: new Date('2026-11-10T10:00:00Z') };
    const busy = [
      { agentId: 'a1', slot, groupId: 'g1' },
      { agentId: 'a2', slot, groupId: 'g2' },
      { agentId: 'a3', slot },
    ];
    expect(conflictingAgents(['a1', 'a2', 'a3'], slot, busy, 'g1')).toEqual(['a2', 'a3']);
    expect(conflictingAgents(['a1'], slot, busy)).toEqual(['a1']);
  });

  it('conservation de la position : N mois avant ; masquage du repère qui sert d’adresse', () => {
    expect(locationRetentionCutoff(new Date('2027-03-31T12:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T12:00:00.000Z',
    );
    expect(locationRetentionCutoff(now, 12).toISOString()).toBe('2025-11-04T10:00:00.000Z');
    const place = {
      address: 'Portail',
      landmark: 'Portail',
      location: { latitude: 1, longitude: 2, accuracyMeters: null },
    };
    expect(withoutPosition(place)).toEqual({ address: '', landmark: null, location: null });
    expect(withoutPosition({ ...place, address: 'Lot 12' }).address).toBe('Lot 12');
  });
});
