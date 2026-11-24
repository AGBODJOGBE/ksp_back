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
import {
  ChangeAgentStatusUseCase,
  GetAgentUseCase,
  ListAgentsUseCase,
  UpdateAgentUseCase,
} from './agent-admin.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );
let keys = 0;

function setup() {
  const planning = new InMemoryPlanning();
  const { deps } = planningDeps(planning);
  const change = (
    action: Parameters<ChangeAgentStatusUseCase['execute']>[0]['action'],
    input: Record<string, unknown> = {},
  ) =>
    asStaff(() =>
      new ChangeAgentStatusUseCase(deps).execute({
        action,
        agentId: 'a1',
        idempotencyKey: `statut-agent-${++keys}`,
        ...input,
      }),
    );
  return { planning, deps, change };
}

/** Affectation confirmée de l'agent a1 sur la séance s1 (lundi 23 novembre). */
function withAssignment(planning: InMemoryPlanning) {
  planning.addTarget(sessionTarget('s1', { status: 'assigned' }));
  planning.addAssignment({
    id: 'as1',
    target: { kind: 'session', id: 's1' },
    agentId: 'a1',
    isLead: false,
    source: 'manual',
    status: 'confirmed',
    respondBefore: null,
    overrides: [],
    reason: null,
    createdBy: STAFF,
    createdAt: NOW,
    start: new Date('2026-11-23T08:00:00Z'),
    end: new Date('2026-11-23T10:00:00Z'),
    occupiedFrom: new Date('2026-11-23T08:00:00Z'),
    occupiedUntil: new Date('2026-11-23T10:00:00Z'),
    travelMinutes: 0,
    placeId: 'place-a',
  });
}

describe('validation d’une candidature (UC-NT-34, R-AG-01)', () => {
  it('en vérification → actif ; compétences validées ; événement de validation', async () => {
    const { planning, change } = setup();
    planning.addAgent(
      agentRecord('a1', {
        status: 'under_review',
        skills: [
          { code: 'interior', name: 'Intérieur', status: 'declared' },
          { code: 'windows', name: 'Vitres', status: 'declared' },
        ],
      }),
    );
    const profile = await change('approve', { validatedSkillCodes: ['interior'] });
    expect(profile.agent.status).toBe('active');
    expect(profile.agent.skills.map((s) => [s.code, s.status])).toEqual([
      ['interior', 'validated'],
      ['windows', 'declared'],
    ]);
    expect(planning.events).toEqual([
      {
        type: 'cleaning.agent.approved',
        payload: {
          agentId: 'a1',
          userId: 'user-a1',
          approvedBy: STAFF,
          skillCodes: ['interior'],
          employmentKind: 'employee',
          approvedAt: NOW.toISOString(),
        },
      },
    ]);
    expect(planning.audit.map((a) => [a.action, a.details])).toEqual([
      ['agent.status_changed', { before: 'under_review', after: 'active' }],
      ['agent.skills_validated', { skillCodes: ['interior'] }],
    ]);
  });

  it('compétence inconnue : CLEANING_SKILL_NOT_FOUND ; candidat non vérifié : transition interdite', async () => {
    const { planning, change } = setup();
    planning.addAgent(agentRecord('a1', { status: 'applicant' }));
    expect(await failure(change('approve', { validatedSkillCodes: ['pool'] }))).toMatchObject({
      code: 'CLEANING_SKILL_NOT_FOUND',
    });
    expect(await failure(change('approve', { validatedSkillCodes: ['interior'] }))).toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'applicant', to: 'active' },
    });
    expect((await change('review')).agent.status).toBe('under_review');
  });

  it('refus : motif obligatoire, candidat refusé directement (décision du 20 novembre 2026)', async () => {
    const { planning, change } = setup();
    planning.addAgent(agentRecord('a1', { status: 'applicant' }));
    expect(await failure(change('reject', { reason: '' }))).toMatchObject({
      code: 'CLEANING_REASON_REQUIRED',
    });
    const profile = await change('reject', { reason: 'Pièce illisible' });
    expect(profile.agent).toMatchObject({ status: 'rejected', statusReason: 'Pièce illisible' });
  });

  it('rejouée avec la même clé : état courant, sans nouvel événement', async () => {
    const { planning, deps } = setup();
    planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    const approve = () =>
      asStaff(() =>
        new ChangeAgentStatusUseCase(deps).execute({
          action: 'approve',
          agentId: 'a1',
          idempotencyKey: 'validation-a1',
          validatedSkillCodes: ['interior'],
        }),
      );
    await approve();
    expect((await approve()).agent.status).toBe('active');
    expect(planning.events).toHaveLength(1);
  });
});

describe('suspension, réactivation, désactivation (R-AG-03)', () => {
  it('suspension : affectations à venir retirées, séance de nouveau à affecter, agents prévenus', async () => {
    const { planning, change } = setup();
    planning.addAgent(agentRecord('a1'));
    withAssignment(planning);
    const profile = await change('suspend', { reason: 'Absences' });
    expect(profile.agent.status).toBe('suspended');
    expect(planning.storedAssignment('as1')).toMatchObject({
      status: 'removed',
      removalReason: 'agent_suspended',
    });
    expect(planning.state.targets.get('session:s1')!.status).toBe('to_assign');
    expect(planning.events.map((e) => e.type)).toEqual(['cleaning.session.unassigned']);
    expect(planning.events[0]!.payload).toMatchObject({ agentIds: ['a1'], cause: 'agent_deactivated' });
    expect((await change('reactivate')).agent.status).toBe('active');
  });

  it('désactivation d’un actif : refusée avec des affectations à venir, sauf réaffectation', async () => {
    const { planning, change } = setup();
    planning.addAgent(agentRecord('a1'));
    withAssignment(planning);
    expect(await failure(change('deactivate', { reason: 'Départ' }))).toMatchObject({
      code: 'CLEANING_AGENT_HAS_ASSIGNMENTS',
      details: { assignments: ['as1'] },
    });
    const profile = await change('deactivate', { reason: 'Départ', reassign: true });
    expect(profile.agent.status).toBe('deactivated');
    expect(planning.storedAssignment('as1')).toMatchObject({
      status: 'removed',
      removalReason: 'agent_deactivated',
    });
  });

  it('agent inconnu : CLEANING_AGENT_NOT_FOUND', async () => {
    const { change } = setup();
    expect(await failure(change('suspend', { reason: 'x' }))).toMatchObject({
      code: 'CLEANING_AGENT_NOT_FOUND',
    });
  });
});

describe('fiche et modification d’un agent (UC-NT-35)', () => {
  it('modifie zones, compétences validées, charge et statut d’emploi ; champs absents inchangés', async () => {
    const { planning, deps } = setup();
    planning.addAgent(agentRecord('a1'));
    const profile = await asStaff(() =>
      new UpdateAgentUseCase(deps).execute({
        agentId: 'a1',
        zoneKeys: ['porto-novo'],
        validatedSkillCodes: ['windows'],
        maxHoursPerDay: 6,
        employmentKind: 'independent',
      }),
    );
    expect(profile.agent).toMatchObject({
      zoneKeys: ['porto-novo'],
      maxHoursDay: 6,
      maxHoursWeek: 48,
      employmentKind: 'independent',
    });
    expect(profile.agent.skills.map((s) => [s.code, s.status])).toEqual([
      ['interior', 'declared'],
      ['windows', 'validated'],
    ]);
    expect(planning.audit.map((a) => a.action)).toEqual(['agent.zones_changed', 'agent.skills_validated']);
    expect(
      await failure(
        asStaff(() => new UpdateAgentUseCase(deps).execute({ agentId: 'a1', maxHoursPerDay: 30 })),
      ),
    ).toMatchObject({ details: { field: 'maxHoursPerDay', reason: 'out_of_range' } });
    expect(
      await failure(
        asStaff(() => new UpdateAgentUseCase(deps).execute({ agentId: 'a1', zoneKeys: ['parakou'] })),
      ),
    ).toMatchObject({ code: 'CLEANING_ZONE_NOT_FOUND' });
  });

  it('liste et fiche ; double authentification exigée au back-office', async () => {
    const { planning, deps } = setup();
    planning.addAgent(agentRecord('a1'));
    const page = await asStaff(() => new ListAgentsUseCase(deps).execute({}));
    expect(page.items.map((p) => p.agent.id)).toEqual(['a1']);
    expect((await asStaff(() => new GetAgentUseCase(deps).execute('a1'))).agent.id).toBe('a1');
    expect(await failure(asStaff(() => new GetAgentUseCase(deps).execute('zz')))).toMatchObject({
      code: 'CLEANING_AGENT_NOT_FOUND',
    });
    expect(await failure(new GetAgentUseCase(deps).execute('a1'))).toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
