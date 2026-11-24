import { type AppError } from '@ksp/platform';
import { AGENT_USER, agentRecord, asUser, InMemoryPlanning, planningDeps } from '../testing/planning-fakes';
import { GetMyAgentProfileUseCase, SubmitAgentApplicationUseCase } from './agent-registration.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );
const FILE = (n: number) => `0192f1c4-0000-7000-8000-0000000f000${n}`;

const APPLICATION = {
  idempotencyKey: 'inscription-0001',
  firstName: ' Awa ',
  lastName: 'Dossou',
  photoFileId: FILE(1),
  idDocumentFrontFileId: FILE(2),
  idDocumentBackFileId: FILE(3),
  residenceCommuneKey: 'cotonou',
  zoneKeys: ['cotonou', 'porto-novo'],
  skillCodes: ['interior'],
  weekly: [
    {
      weekday: 'mon',
      ranges: [
        { start: '07:00', end: '13:00' },
        { start: '15:00', end: '18:00' },
      ],
    },
  ],
  emergencyContact: { name: 'Koffi', phone: '+22997000000' },
  employmentKind: 'independent',
  mobileMoneyNumber: '+22996000000',
};

function setup() {
  const planning = new InMemoryPlanning();
  const { deps } = planningDeps(planning);
  const attached: unknown[] = [];
  deps.photos = {
    attach: async (input) => {
      attached.push(input);
    },
    remove: async () => undefined,
    list: async () => [],
  };
  const submit = (input: Record<string, unknown> = {}) =>
    asUser(() => new SubmitAgentApplicationUseCase(deps).execute({ ...APPLICATION, ...input } as never));
  return { planning, deps, attached, submit };
}

describe('SubmitAgentApplication (UC-NT-19, partie 9.1)', () => {
  it('candidat créé : compétences déclarées, zones, plages, données personnelles chiffrées, événement', async () => {
    const { planning, attached, submit } = setup();
    const profile = await submit();
    const agent = profile.agent;
    expect(agent).toMatchObject({
      userId: AGENT_USER,
      status: 'applicant',
      employmentKind: 'independent',
      displayName: 'Awa Dossou',
      homeCommuneKey: 'cotonou',
      zoneKeys: ['cotonou', 'porto-novo'],
      skills: [{ code: 'interior', status: 'declared' }],
      weekly: [
        { weekday: 1, startMinute: 420, endMinute: 780 },
        { weekday: 1, startMinute: 900, endMinute: 1080 },
      ],
      maxHoursDay: 8,
      maxHoursWeek: 48,
    });
    expect(agent.idDocumentEncrypted).toBe(
      `enc(agent:${agent.id}:id_document):${JSON.stringify({ frontFileId: FILE(2), backFileId: FILE(3) })}`,
    );
    expect(profile).toMatchObject({
      emergencyContact: { name: 'Koffi', phone: '+22997000000' },
      mobileMoneyNumber: '+22996000000',
      hasIdDocument: true,
    });
    expect(attached).toHaveLength(3);
    expect(attached[0]).toEqual({
      fileId: FILE(1),
      subject: { type: 'cleaning_agent', id: agent.id },
      ownerId: AGENT_USER,
    });
    expect(planning.events).toEqual([
      {
        type: 'cleaning.agent.applied',
        payload: expect.objectContaining({
          agentId: agent.id,
          userId: AGENT_USER,
          source: 'self',
          zoneKeys: ['cotonou', 'porto-novo'],
        }),
      },
    ]);
  });

  it('rejouée avec la même clé : même agent ; un second profil est refusé', async () => {
    const { planning, submit } = setup();
    const first = await submit();
    expect((await submit()).agent.id).toBe(first.agent.id);
    expect(planning.events).toHaveLength(1);
    expect(await failure(submit({ idempotencyKey: 'inscription-0002' }))).toMatchObject({
      code: 'CLEANING_AGENT_ALREADY_REGISTERED',
    });
  });

  it('compétence ou zone inconnue, champ manquant, statut d’emploi invalide', async () => {
    const { submit } = setup();
    expect(await failure(submit({ skillCodes: ['pool'] }))).toMatchObject({
      code: 'CLEANING_SKILL_NOT_FOUND',
    });
    expect(await failure(submit({ zoneKeys: ['parakou'] }))).toMatchObject({
      code: 'CLEANING_ZONE_NOT_FOUND',
    });
    expect(await failure(submit({ lastName: ' ' }))).toMatchObject({
      details: { field: 'lastName', reason: 'required' },
    });
    expect(await failure(submit({ zoneKeys: [] }))).toMatchObject({
      details: { field: 'zoneKeys', reason: 'required' },
    });
    expect(await failure(submit({ employmentKind: 'intern' }))).toMatchObject({
      details: { field: 'employmentKind' },
    });
    expect(await failure(submit({ emergencyContact: undefined }))).toMatchObject({
      details: { field: 'emergencyContact' },
    });
    expect(
      await failure(
        submit({
          weekly: [
            {
              weekday: 'mon',
              ranges: [
                { start: '07:00', end: '13:00' },
                { start: '12:00', end: '14:00' },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({ details: { field: 'weekly', reason: 'duplicate' } });
  });
});

describe('GetMyAgentProfile (UC-NT-19)', () => {
  it('mon profil ; sans profil d’agent : CLEANING_AGENT_NOT_FOUND', async () => {
    const { planning, deps } = setup();
    expect(await failure(asUser(() => new GetMyAgentProfileUseCase(deps).execute()))).toMatchObject({
      code: 'CLEANING_AGENT_NOT_FOUND',
    });
    planning.addAgent(agentRecord('a1', { userId: AGENT_USER }));
    expect((await asUser(() => new GetMyAgentProfileUseCase(deps).execute())).agent.id).toBe('a1');
  });
});
