import { type AppError } from '@ksp/platform';
import {
  agentRecord,
  asStaff,
  InMemoryPlanning,
  NOW,
  planningDeps,
  sessionTarget,
  STAFF,
} from '../testing/planning-fakes';
import { PlanningViewUseCases } from './planning-view.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

function setup() {
  const planning = new InMemoryPlanning();
  planning.addAgent(agentRecord('a1', { displayName: 'Awa Dossou' }));
  planning.addTarget(sessionTarget('s1', { status: 'assigned' }));
  // Séance sans agent dans moins de 48 h : urgente.
  planning.addTarget(
    sessionTarget('s2', {
      rank: 2,
      start: new Date('2026-11-21T08:00:00Z'),
      end: new Date('2026-11-21T10:00:00Z'),
    }),
  );
  planning.addAssignment({
    id: 'as1',
    target: { kind: 'session', id: 's1' },
    agentId: 'a1',
    isLead: true,
    source: 'manual',
    status: 'confirmed',
    respondBefore: null,
    overrides: [],
    reason: null,
    createdBy: STAFF,
    createdAt: NOW,
    start: new Date('2026-11-23T08:00:00Z'),
    end: new Date('2026-11-23T10:00:00Z'),
    occupiedFrom: new Date('2026-11-23T07:40:00Z'),
    occupiedUntil: new Date('2026-11-23T10:00:00Z'),
    travelMinutes: 20,
    placeId: 'place-a',
  });
  const { deps } = planningDeps(planning);
  return { use: new PlanningViewUseCases(deps) };
}

describe('planning du back-office (UC-NT-37, partie 9.6)', () => {
  it('cibles de la période, agents, urgence et charge (trajet non compté)', async () => {
    const { use } = setup();
    const planning = await asStaff(() =>
      use.planning({ from: '2026-11-20T00:00:00Z', to: '2026-11-27T00:00:00Z' }),
    );
    expect(planning.items.map((i) => [i.target.id, i.urgent, i.late])).toEqual([
      ['s2', true, false],
      ['s1', false, false],
    ]);
    expect(planning.items[1]!.agents).toEqual([
      { agentId: 'a1', name: 'Awa Dossou', isLead: true, status: 'confirmed' },
    ]);
    expect(planning.loads).toEqual([
      { agentId: 'a1', name: 'Awa Dossou', plannedMinutes: 120, maxMinutes: 48 * 60 },
    ]);
  });

  it('période de 62 jours au plus, fin après le début', async () => {
    const { use } = setup();
    expect(
      await failure(
        asStaff(() => use.planning({ from: '2026-11-20T00:00:00Z', to: '2027-02-20T00:00:00Z' })),
      ),
    ).toMatchObject({ details: { field: 'to', reason: 'out_of_range' } });
    expect(
      await failure(
        asStaff(() => use.planning({ from: '2026-11-20T00:00:00Z', to: '2026-11-19T00:00:00Z' })),
      ),
    ).toMatchObject({ details: { field: 'end', reason: 'out_of_range' } });
  });

  it('colonne « à affecter »', async () => {
    const { use } = setup();
    const page = await asStaff(() => use.unassigned({}));
    expect(page.items.map((i) => i.target.id)).toContain('s2');
  });
});
