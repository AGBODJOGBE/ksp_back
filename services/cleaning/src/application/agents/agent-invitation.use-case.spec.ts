import { AppError } from '@ksp/platform';
import {
  AGENT_USER,
  agentRecord,
  asStaff,
  asUser,
  type FakeAgentAccounts,
  type FakeInvitationSender,
  InMemoryPlanning,
  NOW,
  planningDeps,
  STAFF,
} from '../testing/planning-fakes';
import { INVITATION_VALIDITY_MS, InviteAgentUseCase } from './agent-invitation.use-case';
import { SubmitAgentApplicationUseCase } from './agent-registration.use-cases';
import { InvitationSendFailedError } from './agent.ports';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );
const FILE = (n: number) => `0192f1c4-0000-7000-8000-0000000f000${n}`;
const PHONE = '+2290197000045';
const KEY = 'invitation-agent-0001';
const OTHER_USER = '0192f1c4-0000-7000-8000-00000000a003';
const DAY_MS = 24 * 3_600_000;

const APPLICATION = {
  firstName: 'Awa',
  lastName: 'Dossou',
  photoFileId: FILE(1),
  idDocumentFrontFileId: FILE(2),
  idDocumentBackFileId: FILE(3),
  residenceCommuneKey: 'cotonou',
  zoneKeys: ['cotonou'],
  skillCodes: ['interior'],
  weekly: [{ weekday: 'mon', ranges: [{ start: '07:00', end: '13:00' }] }],
  emergencyContact: { name: 'Koffi', phone: '+22997000000' },
  employmentKind: 'independent',
};

function setup() {
  const planning = new InMemoryPlanning();
  const { deps } = planningDeps(planning);
  const accounts = deps.accounts as FakeAgentAccounts;
  const sender = deps.invitations as FakeInvitationSender;
  deps.photos = { attach: async () => undefined, remove: async () => undefined, list: async () => [] };
  const invite = (phone = '+229 97 00 00 45', idempotencyKey = KEY) =>
    asStaff(() => new InviteAgentUseCase(deps).execute({ idempotencyKey, phone }));
  const apply = (invitationId: string, userId = AGENT_USER, idempotencyKey = 'inscription-0001') =>
    asUser(
      () => new SubmitAgentApplicationUseCase(deps).execute({ ...APPLICATION, idempotencyKey, invitationId }),
      userId,
    );
  /** La personne invitée a ouvert son compte KSP avec le numéro invité. */
  const signedUp = (userId = AGENT_USER) => accounts.byPhone.set(PHONE, { userId, status: 'active' });
  const stored = (id: string) => planning.state.invitations.get(id)!;
  return { planning, deps, accounts, sender, invite, apply, signedUp, stored };
}

describe('InviteAgent (UC-NT-35, R-AG-02)', () => {
  it('invitation enregistrée puis envoyée : numéro chiffré, échéance à 7 jours, trace sans numéro', async () => {
    const { planning, sender, invite, stored } = setup();
    const invitation = await invite();
    const expiresAt = new Date(NOW.getTime() + 7 * DAY_MS);
    expect(INVITATION_VALIDITY_MS).toBe(7 * DAY_MS);
    expect(invitation).toEqual({ id: expect.any(String), phone: PHONE, expiresAt });
    expect(stored(invitation.id)).toMatchObject({
      phoneEncrypted: `enc(agent_invitation:${invitation.id}:phone):${PHONE}`,
      createdBy: STAFF,
      createdAt: NOW,
      expiresAt,
      sentAt: NOW,
      sendAttempts: 1,
      consumedAt: null,
      agentId: null,
    });
    expect(sender.sent).toEqual([{ invitationId: invitation.id, attempt: 1, phone: PHONE, expiresAt }]);
    expect(planning.audit).toEqual([
      expect.objectContaining({
        actorId: STAFF,
        action: 'agent.invited',
        entityType: 'agent_invitation',
        entityId: invitation.id,
        details: { expiresAt: expiresAt.toISOString(), renewed: false },
      }),
    ]);
    expect(planning.events).toEqual([]);
    // Le numéro n'est ni dans l'empreinte, ni dans le journal, ni dans la clé d'idempotence.
    const written = JSON.stringify([
      stored(invitation.id).phoneFingerprint,
      planning.audit,
      [...planning.state.idempotency.values()],
    ]);
    expect(written).not.toContain('97000045');
  });

  it('rejouée avec la même clé : même invitation, aucun second envoi ; autre numéro : clé refusée', async () => {
    const { planning, sender, invite } = setup();
    const first = await invite();
    expect(await invite()).toEqual(first);
    // Le même numéro écrit autrement est la même requête.
    expect(await invite('+2290197000045')).toEqual(first);
    expect(sender.attempts).toEqual([1]);
    expect(planning.state.invitations.size).toBe(1);
    expect(planning.audit).toHaveLength(1);
    expect(await failure(invite('+229 97 00 00 46'))).toMatchObject({
      code: 'CLEANING_IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('numéro dont le compte est déjà agent : CLEANING_AGENT_ALREADY_REGISTERED, rien écrit ni envoyé', async () => {
    const { planning, sender, invite, signedUp } = setup();
    signedUp();
    planning.addAgent(agentRecord('a1', { userId: AGENT_USER }));
    expect(await failure(invite())).toMatchObject({
      kind: 'CONFLICT',
      code: 'CLEANING_AGENT_ALREADY_REGISTERED',
    });
    expect(planning.state.invitations.size).toBe(0);
    expect(sender.attempts).toEqual([]);
    // Un compte sans profil d'agent peut être invité.
    planning.state.agents.clear();
    expect((await invite()).phone).toBe(PHONE);
  });

  it('notification injoignable : invitation gardée, le rejeu reprend le même envoi sans seconde invitation', async () => {
    const { planning, sender, invite, stored } = setup();
    sender.failure = AppError.unavailable('NOTIFICATION_UNAVAILABLE', 'indisponible');
    expect(await failure(invite())).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOTIFICATION_UNAVAILABLE',
    });
    const [id] = [...planning.state.invitations.keys()];
    expect(stored(id!)).toMatchObject({ sentAt: null, sendAttempts: 0 });

    sender.failure = null;
    const invitation = await invite();
    expect(invitation.id).toBe(id);
    // Même tentative : notification écarte le doublon si le premier appel lui était parvenu.
    expect(sender.attempts).toEqual([1, 1]);
    expect(planning.state.invitations.size).toBe(1);
    expect(stored(invitation.id)).toMatchObject({ sentAt: NOW, sendAttempts: 1 });
    expect(planning.audit).toHaveLength(1);
  });

  it('envoi refusé par tous les canaux : NOTIFICATION_UNAVAILABLE, le rejeu envoie la tentative suivante', async () => {
    const { planning, sender, invite, stored } = setup();
    sender.failure = new InvitationSendFailedError();
    expect(await failure(invite())).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOTIFICATION_UNAVAILABLE',
    });
    sender.failure = null;
    const invitation = await invite();
    expect(sender.attempts).toEqual([1, 2]);
    expect(sender.sent).toHaveLength(1);
    expect(planning.state.invitations.size).toBe(1);
    expect(stored(invitation.id)).toMatchObject({ sentAt: NOW, sendAttempts: 2 });
  });

  it('même numéro invité de nouveau avec une autre clé : la même invitation, renouvelée et renvoyée', async () => {
    const { planning, deps, sender, invite } = setup();
    const first = await invite();
    const later = new Date(NOW.getTime() + 2 * DAY_MS);
    deps.clock = { now: () => later };
    const second = await invite('+2290197000045', 'invitation-agent-0002');
    expect(second).toEqual({ id: first.id, phone: PHONE, expiresAt: new Date(later.getTime() + 7 * DAY_MS) });
    expect(sender.attempts).toEqual([1, 2]);
    expect(planning.state.invitations.size).toBe(1);
    expect(planning.audit.map((entry) => entry.details?.['renewed'])).toEqual([false, true]);
  });

  it('réservée à l’admin Nettoyage ; numéro et clé contrôlés', async () => {
    const { planning, deps, sender, invite } = setup();
    const useCase = new InviteAgentUseCase(deps);
    const request = { idempotencyKey: KEY, phone: PHONE };
    expect(await failure(useCase.execute(request))).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await failure(asUser(() => useCase.execute(request)))).toMatchObject({
      code: 'AUTH_MFA_REQUIRED',
    });
    expect(await failure(invite(' '))).toMatchObject({ details: { field: 'phone', reason: 'required' } });
    expect(await failure(invite('97 00 00 45'))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'phone', reason: 'invalid_type' },
    });
    expect(await failure(invite(PHONE, 'court'))).toMatchObject({ details: { field: 'idempotencyKey' } });
    expect(planning.state.invitations.size).toBe(0);
    expect(sender.attempts).toEqual([]);
  });
});

describe('SubmitAgentApplication avec une invitation (R-AG-02)', () => {
  it('inscription de la personne invitée : source invited, invitation consommée, numéro effacé', async () => {
    const { planning, invite, apply, signedUp, stored } = setup();
    const invitation = await invite();
    signedUp();
    const profile = await apply(invitation.id);
    expect(profile.agent).toMatchObject({ userId: AGENT_USER, status: 'applicant' });
    expect(planning.events).toEqual([
      expect.objectContaining({
        type: 'cleaning.agent.applied',
        payload: expect.objectContaining({
          agentId: profile.agent.id,
          userId: AGENT_USER,
          source: 'invited',
        }),
      }),
    ]);
    expect(stored(invitation.id)).toMatchObject({
      consumedAt: NOW,
      agentId: profile.agent.id,
      phoneEncrypted: null,
    });
    // Rejouée avec la même clé : même agent, sans nouveau contrôle de l'invitation.
    expect((await apply(invitation.id)).agent.id).toBe(profile.agent.id);
    expect(planning.state.agents.size).toBe(1);
  });

  it('invitation d’un autre numéro, inconnue, mal formée ou expirée : refusée, aucun agent créé', async () => {
    const { planning, deps, invite, apply, signedUp, stored } = setup();
    const invitation = await invite();
    signedUp();
    const refused = (reason: string) => ({
      kind: 'INVALID_ARGUMENT',
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'invitationId', reason },
    });
    // Le compte connecté n'est pas celui du numéro invité : même refus qu'une invitation inconnue.
    expect(await failure(apply(invitation.id, OTHER_USER))).toMatchObject(refused('invitation_not_found'));
    expect(await failure(apply('0192f1c4-0000-7000-8000-0000000000ff'))).toMatchObject(
      refused('invitation_not_found'),
    );
    expect(await failure(apply('pas-un-identifiant'))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'invitationId' },
    });
    deps.clock = { now: () => invitation.expiresAt };
    expect(await failure(apply(invitation.id))).toMatchObject(refused('invitation_expired'));
    expect(planning.state.agents.size).toBe(0);
    expect(planning.events).toEqual([]);
    expect(stored(invitation.id)).toMatchObject({ consumedAt: null, agentId: null });
  });

  it('invitation déjà utilisée : refusée ; identity injoignable : rien n’est écrit', async () => {
    const { planning, accounts, invite, apply, signedUp, stored } = setup();
    const invitation = await invite();
    signedUp();
    accounts.failure = AppError.unavailable('IDENTITY_UNAVAILABLE', 'indisponible');
    expect(await failure(apply(invitation.id))).toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    expect(planning.state.agents.size).toBe(0);
    expect(stored(invitation.id).consumedAt).toBeNull();

    accounts.failure = null;
    await apply(invitation.id);
    expect(await failure(apply(invitation.id, OTHER_USER, 'inscription-0002'))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'invitationId', reason: 'invitation_consumed' },
    });
    expect(planning.state.agents.size).toBe(1);
  });
});
