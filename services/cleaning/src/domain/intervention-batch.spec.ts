import { planBatch, selectBatchDates } from './intervention-batch';
import { type BusyPeriod, slotFrom } from './schedule';

const A = 'agent-a';
const B = 'agent-b';
const REMAINING = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'];

describe('planification en lot : choix des dates', () => {
  it('sans dates ni limite : toutes les dates restantes', () => {
    expect(selectBatchDates(REMAINING, {})).toEqual({ dates: REMAINING });
  });

  it('jusqu’à une date incluse', () => {
    expect(selectBatchDates(REMAINING, { until: '2026-11-16' })).toEqual({
      dates: ['2026-11-02', '2026-11-09', '2026-11-16'],
    });
  });

  it('un sous-ensemble des dates restantes, trié, sans doublon', () => {
    expect(selectBatchDates(REMAINING, { dates: ['2026-11-23', '2026-11-02', '2026-11-23'] })).toEqual({
      dates: ['2026-11-02', '2026-11-23'],
    });
  });

  it('refuse une date hors des dates restantes, les deux formes ensemble, une limite sans date', () => {
    expect(selectBatchDates(REMAINING, { dates: ['2026-11-03'] })).toEqual({
      problem: { field: 'dates[0]', message: expect.stringContaining('2026-11-03') },
    });
    expect(selectBatchDates(REMAINING, { dates: ['2026-11-02'], until: '2026-11-30' })).toEqual({
      problem: { field: 'until', message: expect.any(String) },
    });
    expect(selectBatchDates(REMAINING, { until: '2026-11-01' })).toEqual({
      problem: { field: 'until', message: expect.any(String) },
    });
    expect(selectBatchDates(REMAINING, { until: '2026-13-01' })).toEqual({
      problem: { field: 'until', message: expect.any(String) },
    });
  });
});

describe('planification en lot : conflits date par date', () => {
  const at = (iso: string, minutes = 120) => slotFrom(new Date(iso), minutes);
  const slots = [
    { date: '2026-11-02', slot: at('2026-11-02T07:00:00Z') },
    { date: '2026-11-09', slot: at('2026-11-09T07:00:00Z') },
    { date: '2026-11-16', slot: at('2026-11-16T07:00:00Z') },
  ];

  it('aucun conflit : toutes les dates', () => {
    expect(planBatch(slots, [A, B], [], null)).toEqual({ free: slots, conflicts: [] });
  });

  it('agent pris ou indisponible : date en conflit avec ses agents, les autres restent libres', () => {
    const busy: BusyPeriod[] = [
      { agentId: A, slot: at('2026-11-09T08:00:00Z', 60) },
      { agentId: B, slot: at('2026-11-09T06:00:00Z', 90) },
      { agentId: B, slot: at('2026-11-16T09:00:00Z', 60) },
    ];
    expect(planBatch(slots, [A, B], busy, null)).toEqual({
      free: [slots[0], slots[2]],
      conflicts: [{ date: '2026-11-09', agentIds: [A, B] }],
    });
  });

  it('passage d’une mission du même groupe : pas un conflit', () => {
    const busy: BusyPeriod[] = [{ agentId: A, slot: at('2026-11-02T07:30:00Z'), groupId: 'g-1' }];
    expect(planBatch(slots, [A], busy, 'g-1').conflicts).toEqual([]);
    expect(planBatch(slots, [A], busy, 'g-2').conflicts).toEqual([{ date: '2026-11-02', agentIds: [A] }]);
  });

  it('les passages du lot ne se chevauchent pas entre eux (passage de nuit long)', () => {
    const night = [
      { date: '2026-11-02', slot: at('2026-11-02T22:00:00Z', 600) },
      { date: '2026-11-03', slot: at('2026-11-03T05:00:00Z', 60) },
    ];
    expect(planBatch(night, [A], [], null)).toEqual({
      free: [night[0]],
      conflicts: [{ date: '2026-11-03', agentIds: [A] }],
    });
  });
});
