import { type AppError } from '@ksp/platform';
import { agentRecord, asStaff, InMemoryPlanning, planningDeps } from '../testing/planning-fakes';
import { TeamUseCases } from './team.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

function setup() {
  const planning = new InMemoryPlanning();
  for (const id of ['a1', 'a2', 'a3']) planning.addAgent(agentRecord(id));
  const { deps } = planningDeps(planning);
  return { planning, teams: new TeamUseCases(deps) };
}

describe('équipes (UC-NT-36, R-EQ-01, R-EQ-03)', () => {
  it('création : le chef fait partie des membres ; rejouée, même équipe ; trace', async () => {
    const { planning, teams } = setup();
    const create = () =>
      asStaff(() =>
        teams.create({
          idempotencyKey: 'equipe-0001',
          name: ' Équipe A ',
          leadAgentId: 'a1',
          memberIds: ['a2'],
        }),
      );
    const team = await create();
    expect(team).toMatchObject({ name: 'Équipe A', leadAgentId: 'a1', active: true });
    expect(team.members.map((m) => m.agentId)).toEqual(['a1', 'a2']);
    expect((await create()).id).toBe(team.id);
    expect(planning.audit.map((a) => a.action)).toEqual(['team.created']);
  });

  it('nom obligatoire ; membre inconnu : CLEANING_AGENT_NOT_FOUND', async () => {
    const { teams } = setup();
    expect(
      await failure(
        asStaff(() =>
          teams.create({ idempotencyKey: 'equipe-0002', name: '', leadAgentId: 'a1', memberIds: [] }),
        ),
      ),
    ).toMatchObject({ details: { field: 'name', reason: 'required' } });
    expect(
      await failure(
        asStaff(() =>
          teams.create({ idempotencyKey: 'equipe-0003', name: 'B', leadAgentId: 'a1', memberIds: ['zz'] }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_AGENT_NOT_FOUND' });
  });

  it('modification : membres remplacés, chef changé, désactivation et réactivation tracées', async () => {
    const { planning, teams } = setup();
    const team = await asStaff(() =>
      teams.create({ idempotencyKey: 'equipe-0004', name: 'C', leadAgentId: 'a1', memberIds: ['a2'] }),
    );
    const updated = await asStaff(() =>
      teams.update({ teamId: team.id, memberIds: ['a3'], leadAgentId: 'a3', active: false }),
    );
    expect(updated).toMatchObject({ leadAgentId: 'a3', active: false });
    expect(updated.members.map((m) => m.agentId)).toEqual(['a3']);
    await asStaff(() => teams.update({ teamId: team.id, active: true }));
    expect(planning.audit.map((a) => a.action)).toEqual([
      'team.created',
      'team.updated',
      'team.deactivated',
      'team.reactivated',
    ]);
    expect(await failure(asStaff(() => teams.update({ teamId: team.id, memberIds: ['a2'] })))).toMatchObject({
      details: { field: 'leadAgentId', reason: 'required' },
    });
    expect(await failure(asStaff(() => teams.get('nope')))).toMatchObject({
      code: 'CLEANING_TEAM_NOT_FOUND',
    });
    expect((await asStaff(() => teams.list({}))).total).toBe(1);
  });
});
