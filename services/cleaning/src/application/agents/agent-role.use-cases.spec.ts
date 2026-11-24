import { AppError } from '@ksp/platform';
import {
  agentRecord,
  asStaff,
  type FakeAgentRoles,
  InMemoryPlanning,
  planningDeps,
} from '../testing/planning-fakes';
import { type AgentAction, ChangeAgentStatusUseCase } from './agent-admin.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );
const identityDown = () =>
  AppError.unavailable('IDENTITY_UNAVAILABLE', 'Le service des comptes est momentanément indisponible.');
let keys = 0;

function setup() {
  const planning = new InMemoryPlanning();
  const { deps } = planningDeps(planning);
  const roles = deps.roles as FakeAgentRoles;
  const change = (action: AgentAction, input: Record<string, unknown> = {}) =>
    asStaff(() =>
      new ChangeAgentStatusUseCase(deps).execute({
        action,
        agentId: 'a1',
        idempotencyKey: `role-agent-${++keys}`,
        ...input,
      }),
    );
  const stored = () => planning.state.agents.get('a1')!;
  return { planning, roles, change, stored };
}

describe('rôle cleaning_agent à la validation et à la réactivation (R-AG-01, ADR-057)', () => {
  it('validation : rôle attribué par identity avant l’activation, attribution gardée sur la fiche', async () => {
    const { planning, roles, change, stored } = setup();
    planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    const profile = await change('approve', { validatedSkillCodes: ['interior'] });
    expect(profile.agent.status).toBe('active');
    expect(roles.granted).toEqual([{ userId: 'user-a1', reason: 'Agent validé' }]);
    expect(stored().roleAssignmentId).toBe(roles.active.get('user-a1'));
    expect(roles.revoked).toEqual([]);
  });

  it('identity injoignable : la validation échoue, rien n’est écrit ; rejouée, elle aboutit', async () => {
    const { planning, roles, change, stored } = setup();
    planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    roles.failure = identityDown();
    const key = { idempotencyKey: 'validation-en-panne', validatedSkillCodes: ['interior'] };
    expect(await failure(change('approve', key))).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
    expect(stored()).toMatchObject({ status: 'under_review', version: 0, roleAssignmentId: null });
    expect(planning.events).toEqual([]);
    expect(planning.audit).toEqual([]);
    expect(planning.state.idempotency.size).toBe(0);

    roles.failure = null;
    expect((await change('approve', key)).agent.status).toBe('active');
    expect(stored().roleAssignmentId).toBe(roles.active.get('user-a1'));
    expect(planning.events.map((event) => event.type)).toEqual(['cleaning.agent.approved']);
  });

  it('refus d’identity (compte pas encore actif) : transmis tel quel, agent toujours en vérification', async () => {
    const { planning, roles, change, stored } = setup();
    planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    roles.failure = AppError.precondition('IDENTITY_ACCOUNT_NOT_ACTIVE', 'Ce compte n’est pas actif.', {
      status: 'pending_verification',
    });
    expect(await failure(change('approve', { validatedSkillCodes: ['interior'] }))).toMatchObject({
      code: 'IDENTITY_ACCOUNT_NOT_ACTIVE',
      details: { status: 'pending_verification' },
    });
    expect(stored().status).toBe('under_review');
    expect(planning.events).toEqual([]);
  });

  it('transition interdite : refusée avant tout appel à identity', async () => {
    const { planning, roles, change } = setup();
    planning.addAgent(agentRecord('a1', { status: 'applicant' }));
    expect(await failure(change('approve', { validatedSkillCodes: ['interior'] }))).toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'applicant', to: 'active' },
    });
    expect(await failure(change('reactivate'))).toMatchObject({ code: 'CLEANING_INVALID_TRANSITION' });
    expect(roles.granted).toEqual([]);
  });

  it('agent refusé pendant la validation : l’attribution restée sans agent actif est retirée', async () => {
    const { planning, roles, change, stored } = setup();
    planning.addAgent(agentRecord('a1', { status: 'rejected' }));
    // Première lecture, avant le verrou : l'agent est encore « en vérification ».
    const read = planning.agentById.bind(planning);
    let stale = true;
    planning.agentById = async (id: string) => {
      const agent = await read(id);
      if (!agent || !stale) return agent;
      stale = false;
      return { ...agent, status: 'under_review' as const };
    };
    expect(await failure(change('approve', { validatedSkillCodes: ['interior'] }))).toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'rejected', to: 'active' },
    });
    expect(roles.granted).toHaveLength(1);
    expect(roles.revoked).toHaveLength(1);
    expect(roles.active.size).toBe(0);
    expect(stored()).toMatchObject({ status: 'rejected', roleAssignmentId: null });
  });

  it('suspension : le rôle est gardé ; réactivation : attribué de nouveau s’il a été retiré', async () => {
    const { planning, roles, change, stored } = setup();
    planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    await change('approve', { validatedSkillCodes: ['interior'] });
    const first = stored().roleAssignmentId;

    expect((await change('suspend', { reason: 'Absences' })).agent.status).toBe('suspended');
    expect(roles.revoked).toEqual([]);
    expect(stored().roleAssignmentId).toBe(first);

    // Rôle retiré entre-temps dans identity (par le super administrateur).
    roles.active.clear();
    expect((await change('reactivate')).agent.status).toBe('active');
    expect(roles.granted.at(-1)).toEqual({ userId: 'user-a1', reason: 'Agent réactivé' });
    expect(stored().roleAssignmentId).toBe(roles.active.get('user-a1'));
    expect(stored().roleAssignmentId).not.toBe(first);
  });
});

describe('rôle cleaning_agent à la désactivation (R-AG-01, R-AG-03)', () => {
  /** Agent actif validé par le service : son attribution est connue. */
  async function activeAgent() {
    const context = setup();
    context.planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    await context.change('approve', { validatedSkillCodes: ['interior'] });
    return { ...context, assignmentId: context.stored().roleAssignmentId! };
  }

  it('le statut est écrit d’abord, le rôle retiré ensuite, puis l’attribution effacée de la fiche', async () => {
    const { roles, change, stored, assignmentId } = await activeAgent();
    const profile = await change('deactivate', { reason: 'Départ' });
    expect(profile.agent.status).toBe('deactivated');
    expect(roles.revoked).toEqual([{ assignmentId, reason: 'Agent désactivé' }]);
    expect(roles.active.size).toBe(0);
    expect(stored().roleAssignmentId).toBeNull();
  });

  it('identity injoignable : l’action échoue, l’agent est déjà désactivé, le retrait reprend au rejeu', async () => {
    const { planning, roles, change, stored, assignmentId } = await activeAgent();
    roles.failure = identityDown();
    const key = { idempotencyKey: 'desactivation-en-panne', reason: 'Départ' };
    expect(await failure(change('deactivate', key))).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
    // Jamais « actif sans rôle » : désactivé, attribution encore notée pour le retrait.
    expect(stored()).toMatchObject({ status: 'deactivated', roleAssignmentId: assignmentId });
    const written = planning.audit.length;

    roles.failure = null;
    expect((await change('deactivate', key)).agent.status).toBe('deactivated');
    expect(roles.revoked).toEqual([{ assignmentId, reason: 'Agent désactivé' }]);
    expect(stored().roleAssignmentId).toBeNull();
    expect(planning.audit).toHaveLength(written);
    // Rejouée encore : plus rien à retirer.
    await change('deactivate', key);
    expect(roles.revoked).toHaveLength(1);
  });

  it('agent sans attribution connue : désactivé sans appel à identity', async () => {
    const { planning, roles, change } = setup();
    planning.addAgent(agentRecord('a1'));
    expect((await change('deactivate', { reason: 'Départ' })).agent.status).toBe('deactivated');
    expect(roles.revoked).toEqual([]);
  });

  it('refus d’une candidature : aucun appel à identity', async () => {
    const { planning, roles, change } = setup();
    planning.addAgent(agentRecord('a1', { status: 'under_review' }));
    await change('reject', { reason: 'Pièce illisible' });
    expect(roles.granted).toEqual([]);
    expect(roles.revoked).toEqual([]);
  });
});
