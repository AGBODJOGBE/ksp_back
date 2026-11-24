import { AppError } from '@ksp/platform';
import {
  asStaff,
  asUser,
  type FakeAgentAccounts,
  type FakeAgentRoles,
  InMemoryPlanning,
  NOW,
  planningDeps,
  STAFF,
} from '../testing/planning-fakes';
import { ChangeAgentStatusUseCase } from './agent-admin.use-cases';
import { CreateAgentUseCase } from './agent-creation.use-case';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );
const FILE = (n: number) => `0192f1c4-0000-7000-8000-0000000f000${n}`;
const PHONE = '+2290197000045';

const REQUEST = {
  idempotencyKey: 'creation-agent-0001',
  phone: '+229 97 00 00 45',
  firstName: ' Awa ',
  lastName: 'Dossou',
  photoFileId: FILE(1),
  idDocumentFrontFileId: FILE(2),
  idDocumentBackFileId: FILE(3),
  residenceCommuneKey: 'cotonou',
  zoneKeys: ['cotonou', 'porto-novo'],
  skillCodes: ['interior'],
  weekly: [{ weekday: 'mon', ranges: [{ start: '07:00', end: '13:00' }] }],
  emergencyContact: { name: 'Koffi', phone: '+22997000000' },
  employmentKind: 'employee',
  mobileMoneyNumber: '+22996000000',
};

function setup() {
  const planning = new InMemoryPlanning();
  const { deps } = planningDeps(planning);
  const accounts = deps.accounts as FakeAgentAccounts;
  const roles = deps.roles as FakeAgentRoles;
  const attached: unknown[] = [];
  deps.photos = {
    attach: async (input) => {
      attached.push(input);
    },
    remove: async () => undefined,
    list: async () => [],
  };
  const create = (input: Record<string, unknown> = {}) =>
    asStaff(() => new CreateAgentUseCase(deps).execute({ ...REQUEST, ...input } as never));
  return { planning, deps, accounts, roles, attached, create };
}

describe('CreateAgent (UC-NT-35, R-AG-02)', () => {
  it('numéro sans compte : compte créé chez identity, agent « en vérification » créé par l’admin', async () => {
    const { planning, accounts, attached, create } = setup();
    const profile = await create();
    const agent = profile.agent;

    // Compte trouvé ou créé par identity, avec le numéro normalisé (ADR-063) et le nom saisi.
    expect(accounts.ensured).toEqual([{ phone: PHONE, firstName: 'Awa', lastName: 'Dossou' }]);
    expect(agent).toMatchObject({
      userId: accounts.byPhone.get(PHONE)!.userId,
      status: 'under_review',
      employmentKind: 'employee',
      displayName: 'Awa Dossou',
      homeCommuneKey: 'cotonou',
      zoneKeys: ['cotonou', 'porto-novo'],
      skills: [{ code: 'interior', status: 'declared' }],
      weekly: [{ weekday: 1, startMinute: 420, endMinute: 780 }],
      roleAssignmentId: null,
    });
    expect(planning.state.agents.get(agent.id)).toMatchObject({ createdBy: STAFF });
    // Mêmes données personnelles chiffrées qu'à l'inscription.
    expect(agent.idDocumentEncrypted).toBe(
      `enc(agent:${agent.id}:id_document):${JSON.stringify({ frontFileId: FILE(2), backFileId: FILE(3) })}`,
    );
    expect(profile).toMatchObject({
      emergencyContact: { name: 'Koffi', phone: '+22997000000' },
      mobileMoneyNumber: '+22996000000',
      hasIdDocument: true,
    });
    // Fichiers envoyés par l'admin, rattachés chez file au nom de l'agent avant l'enregistrement.
    expect(attached).toEqual(
      [FILE(1), FILE(2), FILE(3)].map((fileId) => ({
        fileId,
        subject: { type: 'cleaning_agent', id: agent.id },
        ownerId: STAFF,
      })),
    );
    expect(planning.events).toEqual([
      {
        type: 'cleaning.agent.applied',
        payload: {
          agentId: agent.id,
          userId: agent.userId,
          source: 'admin_created',
          appliedAt: NOW.toISOString(),
          zoneKeys: ['cotonou', 'porto-novo'],
        },
      },
    ]);
    // Trace du back-office : statut d'entrée, jamais le téléphone ni le nom.
    expect(planning.audit).toEqual([
      {
        actorId: STAFF,
        action: 'agent.status_changed',
        entityType: 'agent',
        entityId: agent.id,
        at: NOW,
        details: { before: null, after: 'under_review', source: 'admin_created' },
      },
    ]);
    expect(JSON.stringify([planning.events, planning.audit])).not.toContain('97000045');
  });

  it('l’admin valide ensuite l’agent : le rôle est demandé à identity pour ce compte', async () => {
    const { deps, roles, create } = setup();
    const { agent } = await create();
    const approved = await asStaff(() =>
      new ChangeAgentStatusUseCase(deps).execute({
        action: 'approve',
        agentId: agent.id,
        idempotencyKey: 'validation-agent-cree',
        validatedSkillCodes: ['interior'],
      }),
    );
    expect(approved.agent.status).toBe('active');
    expect(roles.granted).toEqual([{ userId: agent.userId, reason: 'Agent validé' }]);
  });

  it('compte existant : repris tel quel ; un second agent pour le même numéro est refusé', async () => {
    const { planning, accounts, create } = setup();
    accounts.byPhone.set(PHONE, { userId: '0192f1c4-0000-7000-8000-00000000c0de', status: 'active' });
    const first = await create();
    expect(first.agent.userId).toBe('0192f1c4-0000-7000-8000-00000000c0de');
    expect(accounts.created).toEqual([]);
    expect(await failure(create({ idempotencyKey: 'creation-agent-0002' }))).toMatchObject({
      kind: 'CONFLICT',
      code: 'CLEANING_AGENT_ALREADY_REGISTERED',
    });
    // L'autre forme du même numéro désigne le même compte.
    expect(
      await failure(create({ idempotencyKey: 'creation-agent-0003', phone: '+2290197000045' })),
    ).toMatchObject({ code: 'CLEANING_AGENT_ALREADY_REGISTERED' });
    expect(planning.state.agents.size).toBe(1);
    expect(planning.events).toHaveLength(1);
  });

  it('rejouée avec la même clé : le même agent, sans second compte ni second événement', async () => {
    const { planning, accounts, attached, create } = setup();
    const first = await create();
    const again = await create();
    expect(again.agent.id).toBe(first.agent.id);
    expect(accounts.ensured).toHaveLength(1);
    expect(attached).toHaveLength(3);
    expect(planning.events).toHaveLength(1);
    expect(await failure(create({ lastName: 'Autre' }))).toMatchObject({
      code: 'CLEANING_IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('identity injoignable : indisponibilité, rien n’est écrit ; rejouée, la création aboutit', async () => {
    const { planning, accounts, attached, create } = setup();
    accounts.failure = AppError.unavailable('IDENTITY_UNAVAILABLE', 'indisponible');
    expect(await failure(create())).toMatchObject({ kind: 'UNAVAILABLE', code: 'IDENTITY_UNAVAILABLE' });
    expect(planning.state.agents.size).toBe(0);
    expect(planning.state.idempotency.size).toBe(0);
    expect(attached).toEqual([]);
    accounts.failure = null;
    expect((await create()).agent.status).toBe('under_review');
  });

  it('refus d’identity (compte suspendu, nom refusé) : transmis tel quel, aucun agent', async () => {
    const { planning, accounts, create } = setup();
    accounts.failure = AppError.precondition('IDENTITY_ACCOUNT_NOT_USABLE', 'Compte inutilisable.', {
      status: 'suspended',
    });
    expect(await failure(create())).toMatchObject({
      code: 'IDENTITY_ACCOUNT_NOT_USABLE',
      details: { status: 'suspended' },
    });
    expect(planning.state.agents.size).toBe(0);
  });

  it('mêmes contrôles que l’inscription, avant tout appel à identity', async () => {
    const { accounts, create } = setup();
    expect(await failure(create({ phone: '97000045' }))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'phone', reason: 'invalid_type' },
    });
    expect(await failure(create({ phone: '' }))).toMatchObject({
      details: { field: 'phone', reason: 'required' },
    });
    expect(await failure(create({ lastName: ' ' }))).toMatchObject({
      details: { field: 'lastName', reason: 'required' },
    });
    expect(await failure(create({ skillCodes: ['pool'] }))).toMatchObject({
      code: 'CLEANING_SKILL_NOT_FOUND',
    });
    expect(await failure(create({ zoneKeys: ['parakou'] }))).toMatchObject({
      code: 'CLEANING_ZONE_NOT_FOUND',
    });
    expect(await failure(create({ emergencyContact: undefined }))).toMatchObject({
      details: { field: 'emergencyContact' },
    });
    expect(await failure(create({ idempotencyKey: 'court' }))).toMatchObject({
      details: { field: 'idempotencyKey' },
    });
    expect(accounts.ensured).toEqual([]);
  });

  it('réservé à l’admin Nettoyage du back-office', async () => {
    const { deps, accounts } = setup();
    const useCase = new CreateAgentUseCase(deps);
    expect(await failure(useCase.execute(REQUEST))).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await failure(asUser(() => useCase.execute(REQUEST)))).toMatchObject({
      code: 'AUTH_MFA_REQUIRED',
    });
    expect(accounts.ensured).toEqual([]);
  });
});
