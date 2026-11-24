import { type AppError } from '@ksp/platform';
import { checkLink, issueLink } from '../../domain/debtor-access';
import { type Directory } from '../ports';
import { DEFAULT_FULL_SETTINGS } from '../settings.use-cases';
import { RecoveryErrors, unwrap } from '../shared/errors';
import { CapturingNotifier } from '../testing/debtor-access.fakes';
import { asService, FakePersonalData, makeDeps, NOW, rejection } from '../testing/fakes';
import { createUseCases } from '../use-cases';
import { DEBTOR_CONTACT_CONTEXT } from './debtor-contact';
import { DebtorLinks } from './debtor-links.service';

const CASE_ID = '0192f1c4-0000-7000-8000-0000000ca5e1';
const DEBTOR_ID = '0192f1c4-0000-7000-8000-0000000deb01';
const OTHER_DEBTOR_ID = '0192f1c4-0000-7000-8000-0000000deb02';
const CREDITOR_ID = '0192f1c4-0000-7000-8000-00000000c001';
const PHONE = '+2290197000145';
const EMAIL = 'debiteur@example.com';
const UNKNOWN_TOKEN = 'A'.repeat(43);

const after = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

const directory: Directory = {
  usersByIds: async (ids) => ids.map((userId) => ({ userId, displayName: 'Koffi Mensah' })),
  organizationsByIds: async (ids) =>
    ids.map((organizationId) => ({ organizationId, displayName: 'SARL Bénin Propre' })),
};

/** Ce qu'un appelant voit d'une erreur : nature, code, message et détails. */
const shape = (error: unknown) => {
  const { kind, code, message, details } = error as AppError;
  return { kind, code, message, details };
};

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('L’appel aurait dû échouer.');
};

describe('accès du débiteur sans compte (ADR-061)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  let links: DebtorLinks;
  let notifier: CapturingNotifier;
  const personal = new FakePersonalData();

  /** Débiteur du dossier, avec ses coordonnées chiffrées. */
  const addDebtor = (
    options: {
      debtorId?: string;
      contacts?: ('phone' | 'email')[];
      creditorType?: 'user' | 'organization';
      status?: 'active' | 'suspended' | 'closed';
    } = {},
  ) =>
    deps.debtorAccess.reader.add(
      CASE_ID,
      options.debtorId ?? DEBTOR_ID,
      {
        caseNumber: 'RC-000123',
        caseStatus: options.status ?? 'active',
        creditor: { type: options.creditorType ?? 'organization', id: CREDITOR_ID },
      },
      (options.contacts ?? ['phone', 'email']).map((channel) => ({
        channel,
        valueEnc: personal.encrypt(channel === 'phone' ? PHONE : EMAIL, DEBTOR_CONTACT_CONTEXT),
      })),
    );

  const setStatus = (status: 'active' | 'suspended' | 'closed') => {
    deps.debtorAccess.reader.debtors.get(DEBTOR_ID)!.caseDebtor.caseStatus = status;
  };

  // Méthodes du débiteur : appelées par la gateway.
  const gateway = <T>(fn: () => Promise<T>) => asService('gateway', fn);
  const open = (token: string) => gateway(() => useCases.openDebtorAccess.execute({ token }));
  const sendCode = (token: string) => gateway(() => useCases.sendDebtorAccessCode.execute({ token }));
  const verify = (token: string, code: string) =>
    gateway(() => useCases.verifyDebtorAccessCode.execute({ token, code }));
  const resolve = (sessionToken: string | null) =>
    gateway(() => useCases.resolveDebtorSession.execute({ sessionToken }));
  const endSession = (sessionToken: string | null) =>
    gateway(() => useCases.endDebtorSession.execute({ sessionToken }));
  const issue = (debtorId = DEBTOR_ID) => links.issue({ caseId: CASE_ID, debtorId });

  /** Code demandé puis validé : jeton de la session ouverte. */
  const sessionFor = async (token: string) => {
    await sendCode(token);
    return (await verify(token, notifier.lastCode())).sessionToken;
  };
  const setNow = (date: Date) => {
    deps.clock.current = date;
  };
  const wrongCode = () => (notifier.lastCode() === '000000' ? '111111' : '000000');
  const actions = () => deps.debtorAccess.journal.events.map((event) => event.action);

  beforeEach(() => {
    notifier = new CapturingNotifier();
    deps = makeDeps({ notifier, directory });
    useCases = createUseCases(deps);
    links = new DebtorLinks(deps);
    addDebtor();
  });

  describe('émission du lien (DebtorLinks)', () => {
    it('jeton de 32 octets en base64url, adresse du portail, 30 jours ; seule l’empreinte est gardée', async () => {
      const link = await issue();
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(link.url).toBe(`https://ksp.bj/recouvrement/${link.token}`);
      expect(link.expiresAt).toEqual(after(30 * DAY));
      expect(link.renewed).toBe(false);
      const [row] = [...deps.debtorAccess.store.rows.values()];
      expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(link.token);
      expect(deps.debtorAccess.journal.events).toEqual([
        expect.objectContaining({
          caseId: CASE_ID,
          accessId: link.accessId,
          actorType: 'system',
          actorId: null,
          action: 'debtor_link_issued',
          summary: 'Lien personnel du débiteur émis, valable 30 jours.',
        }),
      ]);
    });

    it('validité réglable (debtorLinkDays) ; adresse sans barre finale en double', async () => {
      deps.settings.row = {
        values: { ...DEFAULT_FULL_SETTINGS, debtorLinkDays: 7 },
        updatedAt: NOW,
        updatedBy: null,
      };
      deps.debtorAccess.baseUrl = 'https://ksp.bj/recouvrement/';
      const link = await issue();
      expect(link.expiresAt).toEqual(after(7 * DAY));
      expect(link.url).toBe(`https://ksp.bj/recouvrement/${link.token}`);
    });

    it('renouvelé à chaque relance : nouveau jeton, l’ancien lien et ses sessions révoqués', async () => {
      const first = await issue();
      const session = await sessionFor(first.token);
      setNow(after(DAY));
      const second = await issue();
      expect(second).toMatchObject({ renewed: true, expiresAt: after(31 * DAY) });
      expect(second.token).not.toBe(first.token);
      expect(deps.debtorAccess.journal.events.at(-1)?.summary).toBe(
        'Lien personnel du débiteur renouvelé, valable 30 jours ; le précédent est révoqué.',
      );
      expect((await rejection(open(first.token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
      expect((await rejection(resolve(session))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
      await expect(open(second.token)).resolves.toMatchObject({ creditorName: 'SARL Bénin Propre' });
      const active = [...deps.debtorAccess.store.rows.values()].filter((row) => !row.access.link.revokedAt);
      expect(active.map((row) => row.access.id)).toEqual([second.accessId]);
    });

    it('un lien par débiteur et par dossier : le lien d’un autre débiteur n’est pas touché', async () => {
      addDebtor({ debtorId: OTHER_DEBTOR_ID });
      const mine = await issue();
      const other = await issue(OTHER_DEBTOR_ID);
      expect(other.renewed).toBe(false);
      await expect(open(mine.token)).resolves.toBeDefined();
      await expect(open(other.token)).resolves.toBeDefined();
    });

    it('révoqué (dossier clos) : le lien et ses sessions ne valent plus rien', async () => {
      const link = await issue();
      const session = await sessionFor(link.token);
      await expect(links.revoke({ caseId: CASE_ID })).resolves.toEqual({ revoked: 1 });
      expect((await rejection(open(link.token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
      expect((await rejection(resolve(session))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
      await expect(links.revoke({ caseId: CASE_ID })).resolves.toEqual({ revoked: 0 });
    });

    it('révocation limitée à un débiteur retiré du dossier', async () => {
      addDebtor({ debtorId: OTHER_DEBTOR_ID });
      const mine = await issue();
      const other = await issue(OTHER_DEBTOR_ID);
      await expect(links.revoke({ caseId: CASE_ID, debtorId: OTHER_DEBTOR_ID })).resolves.toEqual({
        revoked: 1,
      });
      await expect(open(mine.token)).resolves.toBeDefined();
      expect((await rejection(open(other.token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
    });

    it('refuse un débiteur hors du dossier, et un dossier ni actif ni suspendu', async () => {
      expect((await rejection(issue(OTHER_DEBTOR_ID))).code).toBe('RECOVERY_CASE_NOT_FOUND');
      expect((await rejection(links.issue({ caseId: 'RC-000123', debtorId: DEBTOR_ID }))).code).toBe(
        'RECOVERY_CASE_NOT_FOUND',
      );
      setStatus('closed');
      expect(await rejection(issue())).toMatchObject({
        code: 'RECOVERY_INVALID_TRANSITION',
        details: { status: 'closed' },
      });
      setStatus('suspended');
      await expect(issue()).resolves.toMatchObject({ renewed: false });
      expect(deps.debtorAccess.store.rows.size).toBe(1);
    });
  });

  describe('ouverture du lien (OpenDebtorAccess)', () => {
    it('nom du créancier, téléphone masqué, fin du lien ; chaque ouverture va au journal', async () => {
      const link = await issue();
      await expect(open(link.token)).resolves.toEqual({
        creditorName: 'SARL Bénin Propre',
        contactMasked: '+229 01 ** ** ** 45',
        linkExpiresAt: link.expiresAt,
      });
      expect(deps.debtorAccess.journal.events.at(-1)).toEqual({
        caseId: CASE_ID,
        accessId: link.accessId,
        occurredAt: NOW,
        actorType: 'debtor',
        actorId: DEBTOR_ID,
        action: 'debtor_link_opened',
        channel: null,
        summary: 'Lien personnel ouvert par le débiteur.',
      });
    });

    it('créancier particulier : son nom ; débiteur sans téléphone : son e-mail masqué', async () => {
      deps.debtorAccess.reader.debtors.clear();
      addDebtor({ creditorType: 'user', contacts: ['email'] });
      const link = await issue();
      await expect(open(link.token)).resolves.toMatchObject({
        creditorName: 'Koffi Mensah',
        contactMasked: 'd***@example.com',
      });
    });

    it('jeton mal formé, inconnu, révoqué ou expiré, dossier clos : la même réponse 404, sans indice', async () => {
      const revoked = await issue();
      await issue(); // renouvelle : le premier est révoqué
      // Même erreur que le refus de la règle du domaine (lien révoqué ou expiré).
      const expected = shape(thrown(() => unwrap(checkLink({ ...issueLink(NOW, 30), revokedAt: NOW }, NOW))));
      const refusals = [
        await rejection(open('trop-court')),
        await rejection(open(UNKNOWN_TOKEN)),
        await rejection(open(revoked.token)),
      ];
      const current = (await issue()).token;
      setNow(after(30 * DAY));
      refusals.push(await rejection(open(current)));
      setNow(NOW);
      setStatus('closed');
      refusals.push(await rejection(open(current)));
      for (const refusal of refusals) expect(shape(refusal)).toEqual(expected);
      expect(expected).toEqual({
        kind: 'NOT_FOUND',
        code: 'RECOVERY_DEBTOR_LINK_INVALID',
        message: 'Ce lien est introuvable ou n’est plus valable.',
        details: {},
      });
    });

    it('sans téléphone ni e-mail valable, le lien ne peut pas s’ouvrir', async () => {
      deps.debtorAccess.reader.debtors.clear();
      addDebtor({ contacts: [] });
      const link = await issue();
      expect((await rejection(open(link.token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
      expect((await rejection(sendCode(link.token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
      expect(notifier.sent).toHaveLength(0);
    });

    it('réservé à la gateway', async () => {
      const link = await issue();
      const refusal = await rejection(
        asService('cleaning', () => useCases.openDebtorAccess.execute({ token: link.token })),
      );
      expect(refusal.code).toBe('RECOVERY_CALLER_FORBIDDEN');
    });
  });

  describe('code d’accès (SendDebtorAccessCode)', () => {
    it('6 chiffres au téléphone par WhatsApp, valable 10 minutes ; seule son empreinte est gardée', async () => {
      const link = await issue();
      await expect(sendCode(link.token)).resolves.toEqual({
        channel: 'whatsapp',
        codeExpiresAt: after(10 * MINUTE),
        retryAfterSeconds: 60,
      });
      expect(notifier.sent).toEqual([
        {
          message: 'access_code',
          channel: 'whatsapp',
          phone: PHONE,
          email: null,
          variables: { code: expect.stringMatching(/^[0-9]{6}$/), expires_in_minutes: '10' },
          idempotencyKey: `debtor-access:${link.accessId}:code:1`,
        },
      ]);
      const access = deps.debtorAccess.store.activeOf(DEBTOR_ID)!;
      expect(access).toMatchObject({ codeSentAt: NOW, codesSent: 1 });
      expect(access.code?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(access)).not.toContain(notifier.lastCode());
      expect(deps.debtorAccess.journal.events.at(-1)).toMatchObject({
        actorType: 'system',
        actorId: null,
        action: 'debtor_code_sent',
        channel: 'whatsapp',
        summary: 'Code d’accès envoyé au débiteur par WhatsApp.',
      });
    });

    it('débiteur sans téléphone : le code part à l’e-mail du dossier', async () => {
      deps.debtorAccess.reader.debtors.clear();
      addDebtor({ contacts: ['email'] });
      const link = await issue();
      await expect(sendCode(link.token)).resolves.toMatchObject({ channel: 'email' });
      expect(notifier.sent[0]).toMatchObject({ channel: 'email', phone: null, email: EMAIL });
      expect(deps.debtorAccess.journal.events.at(-1)?.summary).toBe(
        'Code d’accès envoyé au débiteur par e-mail.',
      );
    });

    it('un code par minute : RECOVERY_DEBTOR_CODE_TOO_SOON ; le nouveau code remplace l’ancien', async () => {
      const link = await issue();
      await sendCode(link.token);
      const firstCode = notifier.lastCode();
      setNow(after(20));
      expect(await rejection(sendCode(link.token))).toMatchObject({
        code: 'RECOVERY_DEBTOR_CODE_TOO_SOON',
        details: { retryAfterSeconds: 40 },
      });
      expect(notifier.sent).toHaveLength(1);
      setNow(after(MINUTE));
      await expect(sendCode(link.token)).resolves.toMatchObject({ codeExpiresAt: after(11 * MINUTE) });
      expect(notifier.sent.map((sent) => sent.idempotencyKey)).toEqual([
        `debtor-access:${link.accessId}:code:1`,
        `debtor-access:${link.accessId}:code:2`,
      ]);
      expect((await rejection(verify(link.token, firstCode))).code).toBe('RECOVERY_DEBTOR_CODE_INVALID');
      await expect(verify(link.token, notifier.lastCode())).resolves.toBeDefined();
    });

    it('notification en panne : l’erreur est rendue et une nouvelle demande passe aussitôt', async () => {
      const link = await issue();
      notifier.failure = RecoveryErrors.dependencyUnavailable('notification');
      expect((await rejection(sendCode(link.token))).code).toBe('RECOVERY_DEPENDENCY_UNAVAILABLE');
      expect(actions()).not.toContain('debtor_code_sent');
      notifier.failure = null;
      await expect(sendCode(link.token)).resolves.toMatchObject({ channel: 'whatsapp' });
      expect(notifier.sent[0]!.idempotencyKey).toBe(`debtor-access:${link.accessId}:code:2`);
    });
  });

  describe('validation du code (VerifyDebtorAccessCode)', () => {
    it('code juste : session de 30 minutes rendue une seule fois, code consommé', async () => {
      const link = await issue();
      await sendCode(link.token);
      const code = notifier.lastCode();
      const session = await verify(link.token, code);
      expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(session.sessionExpiresAt).toEqual(after(30 * MINUTE));
      const [stored] = [...deps.debtorAccess.store.sessions.values()];
      expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(session.sessionToken);
      expect(deps.debtorAccess.store.activeOf(DEBTOR_ID)?.code).toBeNull();
      expect(deps.debtorAccess.journal.events.at(-1)).toMatchObject({
        actorType: 'debtor',
        actorId: DEBTOR_ID,
        action: 'debtor_code_verified',
      });
      // Un code ne sert qu'une fois : chaque ouverture demande un nouveau code.
      expect((await rejection(verify(link.token, code))).code).toBe('RECOVERY_DEBTOR_CODE_EXPIRED');
      await expect(resolve(session.sessionToken)).resolves.toMatchObject({
        caseId: CASE_ID,
        debtorId: DEBTOR_ID,
        accessId: link.accessId,
      });
    });

    it('durée de session réglable (debtorSessionMinutes)', async () => {
      deps.settings.row = {
        values: { ...DEFAULT_FULL_SETTINGS, debtorSessionMinutes: 60 },
        updatedAt: NOW,
        updatedBy: null,
      };
      const link = await issue();
      await sendCode(link.token);
      await expect(verify(link.token, notifier.lastCode())).resolves.toMatchObject({
        sessionExpiresAt: after(60 * MINUTE),
      });
    });

    it('5 codes faux : accès bloqué une heure, même au bon code ; ensuite le compteur repart de zéro', async () => {
      const link = await issue();
      await sendCode(link.token);
      const code = notifier.lastCode();
      for (const left of [4, 3, 2, 1]) {
        expect(await rejection(verify(link.token, wrongCode()))).toMatchObject({
          code: 'RECOVERY_DEBTOR_CODE_INVALID',
          details: { attemptsLeft: left },
        });
      }
      expect(await rejection(verify(link.token, wrongCode()))).toMatchObject({
        code: 'RECOVERY_DEBTOR_LOCKED',
        details: { retryAfterSeconds: HOUR },
      });
      expect(actions().filter((action) => action === 'debtor_access_locked')).toHaveLength(1);
      expect(await rejection(verify(link.token, code))).toMatchObject({
        code: 'RECOVERY_DEBTOR_LOCKED',
        details: { retryAfterSeconds: HOUR },
      });
      setNow(after(30 * MINUTE));
      expect(await rejection(sendCode(link.token))).toMatchObject({
        code: 'RECOVERY_DEBTOR_LOCKED',
        details: { retryAfterSeconds: 30 * MINUTE },
      });
      // Six essais, cinq comparaisons : l'essai bloqué ne compare rien.
      expect(deps.debtorAccess.secrets.comparisons).toBe(5);

      setNow(after(HOUR));
      await sendCode(link.token);
      expect(await rejection(verify(link.token, wrongCode()))).toMatchObject({
        details: { attemptsLeft: 4 },
      });
      await expect(verify(link.token, notifier.lastCode())).resolves.toBeDefined();
      expect(deps.debtorAccess.store.activeOf(DEBTOR_ID)?.attempts).toEqual({
        failures: 0,
        lockedUntil: null,
      });
    });

    it('code expiré après 10 minutes, ou jamais demandé : RECOVERY_DEBTOR_CODE_EXPIRED, sans essai compté', async () => {
      const link = await issue();
      expect((await rejection(verify(link.token, '123456'))).code).toBe('RECOVERY_DEBTOR_CODE_EXPIRED');
      await sendCode(link.token);
      setNow(after(10 * MINUTE));
      expect((await rejection(verify(link.token, notifier.lastCode()))).code).toBe(
        'RECOVERY_DEBTOR_CODE_EXPIRED',
      );
      expect(deps.debtorAccess.store.activeOf(DEBTOR_ID)?.attempts.failures).toBe(0);
    });

    it('code mal formé : RECOVERY_VALIDATION_FAILED, sans essai compté', async () => {
      const link = await issue();
      await sendCode(link.token);
      expect(await rejection(verify(link.token, '12345'))).toMatchObject({
        code: 'RECOVERY_VALIDATION_FAILED',
        details: { field: 'code' },
      });
      expect(deps.debtorAccess.store.activeOf(DEBTOR_ID)?.attempts.failures).toBe(0);
      expect((await rejection(verify(UNKNOWN_TOKEN, '123456'))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
    });
  });

  describe('session du débiteur', () => {
    it('absente, mal formée, inconnue, expirée, fermée, révoquée ou dossier clos : la même réponse 401', async () => {
      const link = await issue();
      const ended = await sessionFor(link.token);
      await endSession(ended);
      setNow(after(2 * MINUTE));
      const expired = await sessionFor(link.token);
      setNow(after(4 * MINUTE));
      const live = await sessionFor(link.token);

      const refusals = [
        await rejection(resolve(null)),
        await rejection(resolve('trop-court')),
        await rejection(resolve(UNKNOWN_TOKEN)),
        await rejection(resolve(ended)),
      ];
      setNow(after(2 * MINUTE + 30 * MINUTE));
      refusals.push(await rejection(resolve(expired)));
      await expect(resolve(live)).resolves.toBeDefined();
      setStatus('closed');
      refusals.push(await rejection(resolve(live)));
      setStatus('active');
      await links.revoke({ caseId: CASE_ID });
      refusals.push(await rejection(resolve(live)));

      for (const refusal of refusals) {
        expect(shape(refusal)).toEqual({
          kind: 'UNAUTHENTICATED',
          code: 'RECOVERY_DEBTOR_SESSION_INVALID',
          message: 'Votre session a expiré : rouvrez le lien reçu par message.',
          details: {},
        });
      }
    });

    it('fin de session : révoquée et écrite au journal ; une seconde fin répond 401', async () => {
      const link = await issue();
      const session = await sessionFor(link.token);
      setNow(after(5 * MINUTE));
      await expect(endSession(session)).resolves.toEqual({ endedAt: after(5 * MINUTE) });
      expect(deps.debtorAccess.journal.events.at(-1)).toMatchObject({
        caseId: CASE_ID,
        accessId: link.accessId,
        actorType: 'debtor',
        actorId: DEBTOR_ID,
        action: 'debtor_session_ended',
      });
      expect((await rejection(resolve(session))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
      expect((await rejection(endSession(session))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
    });
  });

  it('ni coordonnée, ni jeton, ni code, ni session dans le journal de preuve et les erreurs', async () => {
    const link = await issue();
    await open(link.token);
    await sendCode(link.token);
    const code = notifier.lastCode();
    const errors = [await rejection(verify(link.token, wrongCode()))];
    const session = (await verify(link.token, code)).sessionToken;
    await endSession(session);
    errors.push(await rejection(resolve(session)), await rejection(open(UNKNOWN_TOKEN)));
    expect(actions()).toEqual([
      'debtor_link_issued',
      'debtor_link_opened',
      'debtor_code_sent',
      'debtor_code_verified',
      'debtor_session_ended',
    ]);
    const written = JSON.stringify([deps.debtorAccess.journal.events, errors.map(shape)]);
    for (const secret of [PHONE, '97000145', EMAIL, link.token, code, session]) {
      expect(written).not.toContain(secret);
    }
  });
});
