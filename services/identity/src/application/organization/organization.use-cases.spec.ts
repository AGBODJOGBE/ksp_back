import { AppError, type RequestContext, runWithContext } from '@ksp/platform';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { type EmailCodeSender } from '../email/email.ports';
import { PendingEmails } from '../email/pending-email';
import {
  InMemoryChallenges,
  InMemoryEmailVerifications,
  InMemoryIdentityStore,
  InMemoryOrganizations,
} from '../testing/fakes';
import {
  DecideOrganizationUseCase,
  GetOrganizationUseCase,
  ListOrganizationsUseCase,
} from './organization-admin.use-cases';
import {
  ChangeOrganizationBillingEmailUseCase,
  ConfirmOrganizationBillingEmailUseCase,
  CreateOrganizationUseCase,
  GetMyOrganizationUseCase,
  ListMyOrganizationsUseCase,
} from './organization.use-cases';

const CLIENT = '0192f1c4-0000-7000-8000-00000000c001';
const OTHER = '0192f1c4-0000-7000-8000-00000000c002';
const ADMIN = '0192f1c4-0000-7000-8000-00000000ad01';

const policy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 900,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

const FORM = {
  legalName: 'SARL Bénin Propre',
  address: 'Lot 1234, Haie Vive, Cotonou',
  ifu: '3201 9123 45678',
  rccm: 'rb/cot/19 b 12345',
};

function setup() {
  let now = new Date('2026-10-27T10:00:00Z');
  let seq = 0;
  const ids = { next: () => `0192f1c4-0000-7000-8000-${String(++seq).padStart(12, '0')}` };
  const clock = { now: () => now };
  const store = new InMemoryIdentityStore(new InMemoryChallenges());
  store.accounts.push({
    id: CLIENT,
    status: 'active',
    firstName: 'Koffi',
    lastName: 'Adjovi',
    phoneE164: '+2290197000045',
    email: 'koffi@exemple.com',
    emailVerifiedAt: now,
    preferredLanguage: 'fr',
    createdAt: now,
  });
  const organizations = new InMemoryOrganizations(store);
  const verifications = new InMemoryEmailVerifications(store, organizations);
  const pending = new PendingEmails(verifications, clock, policy.maxAttempts);
  const sent: Parameters<EmailCodeSender['send']>[0][] = [];
  const sender: EmailCodeSender = { send: async (input) => void sent.push(input) };
  const hasher = {
    hash: (id: string, code: string) => `hmac(${id}:${code})`,
    matches: (id: string, code: string, hash: string) => hash === `hmac(${id}:${code})`,
  };
  return {
    organizations,
    verifications,
    store,
    sent,
    create: new CreateOrganizationUseCase(organizations, pending, ids, clock),
    listMine: new ListMyOrganizationsUseCase(organizations, pending),
    getMine: new GetMyOrganizationUseCase(organizations, pending),
    changeEmail: new ChangeOrganizationBillingEmailUseCase(
      organizations,
      verifications,
      sender,
      hasher,
      { generate: () => '482913' },
      ids,
      clock,
      policy,
    ),
    confirmEmail: new ConfirmOrganizationBillingEmailUseCase(
      organizations,
      verifications,
      pending,
      hasher,
      clock,
      policy,
    ),
    list: new ListOrganizationsUseCase(organizations),
    get: new GetOrganizationUseCase(organizations),
    decide: new DecideOrganizationUseCase(organizations, ids, clock),
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

/** Membre du back-office : rôles et double authentification de la session. */
function asStaff<T>(roles: string[], fn: () => Promise<T>, mfa = true): Promise<T> {
  const context: RequestContext = {
    correlationId: 'c',
    user: {
      userId: ADMIN,
      sessionId: 's-admin',
      activeContext: 'personal',
      roles: roles.map((role) => ({ role, scopeType: 'global' as const })),
      mfa,
      authTime: Math.floor(Date.now() / 1000),
    },
  };
  return runWithContext(context, fn);
}

describe('CreateOrganizationUseCase (UC-ID-12)', () => {
  it('crée la demande en attente de validation, le demandeur en est l’administrateur', async () => {
    const { create, organizations } = setup();
    const created = await create.execute({ userId: CLIENT, ...FORM });
    expect(created).toMatchObject({
      role: 'org_admin',
      pendingBillingEmail: null,
      organization: {
        legalName: 'SARL Bénin Propre',
        ifu: '3201912345678',
        rccm: 'RB/COT/19 B 12345',
        status: 'pending_review',
        billingEmail: null,
        createdBy: CLIENT,
      },
    });
    expect(organizations.events.map((event) => event.type)).toEqual([
      'identity.organization.created',
      'identity.member.added',
    ]);
    expect(organizations.events[0].payload).toMatchObject({ legalName: 'SARL Bénin Propre' });
  });

  it('RCCM facultatif ; IFU, raison sociale et adresse contrôlés', async () => {
    const { create } = setup();
    await expect(create.execute({ userId: CLIENT, ...FORM, rccm: ' ' })).resolves.toMatchObject({
      organization: { rccm: null },
    });
    const ifu = await expectAppError(
      create.execute({ userId: CLIENT, ...FORM, ifu: '12345' }),
      'IDENTITY_ORGANIZATION_INVALID',
    );
    expect(ifu.details).toEqual({ field: 'ifu' });
    for (const [field, value] of [
      ['legalName', ' '],
      ['address', 'ici'],
      ['rccm', '<b>'],
    ] as const) {
      const error = await expectAppError(
        create.execute({ userId: CLIENT, ...FORM, [field]: value }),
        'IDENTITY_ORGANIZATION_INVALID',
      );
      expect(error.details).toEqual({ field });
    }
  });

  it('un IFU n’appartient qu’à une organisation non refusée', async () => {
    const { create, decide } = setup();
    const first = await create.execute({ userId: CLIENT, ...FORM });
    await expectAppError(create.execute({ userId: OTHER, ...FORM }), 'IDENTITY_ORGANIZATION_ALREADY_EXISTS');
    await asStaff(['super_admin'], () =>
      decide.execute({ organizationId: first.organization.id, decision: 'reject', reason: 'IFU inconnu' }),
    );
    await expect(create.execute({ userId: OTHER, ...FORM })).resolves.toMatchObject({
      organization: { status: 'pending_review' },
    });
  });

  it('au plus 3 demandes en attente par compte', async () => {
    const { create } = setup();
    for (const ifu of ['1000000000001', '1000000000002', '1000000000003']) {
      await create.execute({ userId: CLIENT, ...FORM, ifu });
    }
    const error = await expectAppError(
      create.execute({ userId: CLIENT, ...FORM, ifu: '1000000000004' }),
      'IDENTITY_ORGANIZATION_TOO_MANY_PENDING',
    );
    expect(error.details).toEqual({ maximum: 3 });
  });
});

describe('Organisations du client', () => {
  it('liste ses organisations ; celle d’un autre est introuvable', async () => {
    const { create, listMine, getMine } = setup();
    const mine = await create.execute({ userId: CLIENT, ...FORM });
    await create.execute({ userId: OTHER, ...FORM, ifu: '9999999999999' });
    const listed = await listMine.execute(CLIENT);
    expect(listed.map((membership) => membership.organization.id)).toEqual([mine.organization.id]);
    await expect(getMine.execute(CLIENT, mine.organization.id)).resolves.toMatchObject({ role: 'org_admin' });
    await expectAppError(getMine.execute(OTHER, mine.organization.id), 'IDENTITY_ORGANIZATION_NOT_FOUND');
    await expectAppError(getMine.execute(CLIENT, 'pas-un-uuid'), 'IDENTITY_ORGANIZATION_NOT_FOUND');
  });
});

describe('E-mail de facturation (ADR-026, ADR-027)', () => {
  it('code envoyé à l’adresse, enregistrée seulement après la confirmation', async () => {
    const { create, changeEmail, confirmEmail, getMine, sent, store } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });

    const issued = await changeEmail.execute({
      userId: CLIENT,
      organizationId: organization.id,
      email: ' Compta@BeninPropre.bj ',
      ip: null,
    });
    expect(issued).toEqual({
      pendingEmail: 'compta@beninpropre.bj',
      expiresInSeconds: 900,
      resendAfterSeconds: 60,
    });
    expect(sent).toEqual([
      expect.objectContaining({ code: '482913', organizationName: 'SARL Bénin Propre', userId: CLIENT }),
    ]);
    await expect(getMine.execute(CLIENT, organization.id)).resolves.toMatchObject({
      organization: { billingEmail: null },
      pendingBillingEmail: 'compta@beninpropre.bj',
    });

    await expectAppError(
      confirmEmail.execute({ userId: CLIENT, organizationId: organization.id, code: '000000' }),
      'IDENTITY_OTP_INVALID',
    );
    const confirmed = await confirmEmail.execute({
      userId: CLIENT,
      organizationId: organization.id,
      code: '482913',
    });
    expect(confirmed).toMatchObject({
      organization: { billingEmail: 'compta@beninpropre.bj' },
      pendingBillingEmail: null,
    });
    // L'e-mail du profil n'est pas touché.
    expect(store.accounts[0].email).toBe('koffi@exemple.com');
  });

  it('le code de l’organisation ne confirme pas l’e-mail du profil', async () => {
    const { create, changeEmail, verifications } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });
    await changeEmail.execute({ userId: CLIENT, organizationId: organization.id, email: 'a@b.bj', ip: null });
    await expect(verifications.findLatest(CLIENT)).resolves.toBeNull();
  });

  it('réservé à un administrateur de l’organisation, en attente ou validée', async () => {
    const { create, changeEmail, decide } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });
    await expectAppError(
      changeEmail.execute({ userId: OTHER, organizationId: organization.id, email: 'a@b.bj', ip: null }),
      'IDENTITY_ORGANIZATION_NOT_FOUND',
    );
    await asStaff(['super_admin'], () =>
      decide.execute({ organizationId: organization.id, decision: 'reject', reason: 'Doublon' }),
    );
    const error = await expectAppError(
      changeEmail.execute({ userId: CLIENT, organizationId: organization.id, email: 'a@b.bj', ip: null }),
      'IDENTITY_ORGANIZATION_NOT_ACTIVE',
    );
    expect(error.details).toEqual({ status: 'rejected' });
  });

  it('adresse mal formée ou déjà celle de l’organisation', async () => {
    const { create, changeEmail, confirmEmail } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });
    const input = { userId: CLIENT, organizationId: organization.id, ip: null };
    await expectAppError(changeEmail.execute({ ...input, email: 'compta@' }), 'IDENTITY_EMAIL_INVALID');
    await changeEmail.execute({ ...input, email: 'a@b.bj' });
    await confirmEmail.execute({ userId: CLIENT, organizationId: organization.id, code: '482913' });
    await expectAppError(
      changeEmail.execute({ ...input, email: 'A@B.bj' }),
      'IDENTITY_EMAIL_ALREADY_VERIFIED',
    );
  });
});

describe('Validation au back-office', () => {
  it('rôle super_admin et double authentification exigés pour décider', async () => {
    const { create, decide } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });
    const input = { organizationId: organization.id, decision: 'validate' as const };
    await expectAppError(
      asStaff(['support_agent'], () => decide.execute(input)),
      'AUTH_FORBIDDEN',
    );
    await expectAppError(
      asStaff(['super_admin'], () => decide.execute(input), false),
      'AUTH_MFA_REQUIRED',
    );
    await expect(asStaff(['super_admin'], () => decide.execute(input))).resolves.toMatchObject({
      status: 'active',
      reviewedBy: ADMIN,
    });
  });

  it('consultation ouverte au support ; liste filtrée par état, membres avec leurs coordonnées', async () => {
    const { create, list, get } = setup();
    const first = await create.execute({ userId: CLIENT, ...FORM });
    await create.execute({ userId: CLIENT, ...FORM, ifu: '1000000000002' });
    const page = await asStaff(['support_agent'], () =>
      list.execute({ status: 'pending_review', limit: 1, cursor: '' }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0].id);
    const next = await asStaff(['support_agent'], () =>
      list.execute({ status: 'pending_review', limit: 1, cursor: page.nextCursor! }),
    );
    expect(next).toMatchObject({ items: [{ id: first.organization.id }], nextCursor: null });
    await expect(asStaff(['support_agent'], () => get.execute(first.organization.id))).resolves.toMatchObject(
      {
        members: [{ userId: CLIENT, role: 'org_admin', firstName: 'Koffi', phoneE164: '+2290197000045' }],
      },
    );
    await expectAppError(
      asStaff(['cleaning_admin'], () => list.execute({ status: null, limit: 0, cursor: '' })),
      'AUTH_FORBIDDEN',
    );
  });

  it('refus et suspension avec motif ; transitions impossibles refusées ; décision tracée', async () => {
    const { create, decide, organizations } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });
    const id = organization.id;
    const as = <T>(fn: () => Promise<T>) => asStaff(['super_admin'], fn);

    const noReason = await expectAppError(
      as(() => decide.execute({ organizationId: id, decision: 'reject', reason: '  ' })),
      'IDENTITY_ORGANIZATION_INVALID',
    );
    expect(noReason.details).toEqual({ field: 'reason' });
    const tooEarly = await expectAppError(
      as(() => decide.execute({ organizationId: id, decision: 'suspend', reason: 'Fraude' })),
      'IDENTITY_ORGANIZATION_INVALID_TRANSITION',
    );
    expect(tooEarly.details).toEqual({ from: 'pending_review', action: 'suspend' });

    await as(() => decide.execute({ organizationId: id, decision: 'validate' }));
    await expect(
      as(() => decide.execute({ organizationId: id, decision: 'suspend', reason: 'Usurpation signalée' })),
    ).resolves.toMatchObject({ status: 'suspended', suspensionReason: 'Usurpation signalée' });
    await expect(
      as(() => decide.execute({ organizationId: id, decision: 'reactivate' })),
    ).resolves.toMatchObject({
      status: 'active',
      suspensionReason: null,
    });
    expect(organizations.audit.map((entry) => [entry.decision, entry.actorId])).toEqual([
      ['validate', ADMIN],
      ['suspend', ADMIN],
      ['reactivate', ADMIN],
    ]);
    await expectAppError(
      as(() =>
        decide.execute({ organizationId: '0192f1c4-0000-7000-8000-0000000000ff', decision: 'validate' }),
      ),
      'IDENTITY_ORGANIZATION_NOT_FOUND',
    );
  });

  it('deux décisions simultanées : la seconde voit l’état réel', async () => {
    const { create, decide, organizations } = setup();
    const { organization } = await create.execute({ userId: CLIENT, ...FORM });
    organizations.raceOnNextDecision = 'rejected';
    const error = await expectAppError(
      asStaff(['super_admin'], () =>
        decide.execute({ organizationId: organization.id, decision: 'validate' }),
      ),
      'IDENTITY_ORGANIZATION_INVALID_TRANSITION',
    );
    expect(error.details).toEqual({ from: 'rejected', action: 'validate' });
  });
});
