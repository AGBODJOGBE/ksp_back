import { Metadata } from '@grpc/grpc-js';
import { DEBTOR_CONTACT_CONTEXT } from '../../application/debtor-access/debtor-contact';
import { DebtorLinks } from '../../application/debtor-access/debtor-links.service';
import { CapturingNotifier } from '../../application/testing/debtor-access.fakes';
import { asService, FakePersonalData, makeDeps, NOW, rejection } from '../../application/testing/fakes';
import { createUseCases } from '../../application/use-cases';
import { DEBTOR_SESSION_METADATA } from './debtor-session';
import { RecoveryDebtorGrpcController } from './recovery.controller';

const CASE_ID = '0192f1c4-0000-7000-8000-0000000ca5e1';
const DEBTOR_ID = '0192f1c4-0000-7000-8000-0000000deb01';

/** Méthodes portées par la session du débiteur, livrées avec leurs cas d'usage. */
const SESSION_METHODS = [
  'getDebtorCase',
  'createDebtorPayment',
  'simulateDebtorPaymentPlan',
  'proposeDebtorPaymentPlan',
  'resendDebtorPlanSignature',
  'disputeDebtorCase',
  'createDebtorUpload',
  'completeDebtorUpload',
  'requestDebtorCallback',
  'getDebtorDocumentUrl',
] as const;

/** Métadonnées posées par la gateway : la session dans x-debtor-session. */
function withSession(sessionToken: string): Metadata {
  const metadata = new Metadata();
  metadata.set(DEBTOR_SESSION_METADATA, sessionToken);
  return metadata;
}

describe('RecoveryDebtorGrpcController (ADR-061)', () => {
  let controller: RecoveryDebtorGrpcController;
  let notifier: CapturingNotifier;
  let links: DebtorLinks;

  const gateway = <T>(fn: () => Promise<T>) => asService('gateway', fn);
  const callSessionMethod = (method: (typeof SESSION_METHODS)[number], metadata?: Metadata) =>
    gateway(() =>
      (controller[method] as (request: never, metadata?: Metadata) => Promise<unknown>).call(
        controller,
        {} as never,
        metadata,
      ),
    );

  beforeEach(() => {
    notifier = new CapturingNotifier();
    const deps = makeDeps({
      notifier,
      directory: {
        usersByIds: async () => [],
        organizationsByIds: async (ids) =>
          ids.map((organizationId) => ({ organizationId, displayName: 'SARL Bénin Propre' })),
      },
    });
    deps.debtorAccess.reader.add(
      CASE_ID,
      DEBTOR_ID,
      {
        caseNumber: 'RC-000123',
        caseStatus: 'active',
        creditor: { type: 'organization', id: '0192f1c4-0000-7000-8000-00000000c0a1' },
      },
      [
        {
          channel: 'phone',
          valueEnc: new FakePersonalData().encrypt('+2290197000145', DEBTOR_CONTACT_CONTEXT),
        },
      ],
    );
    controller = new RecoveryDebtorGrpcController(createUseCases(deps));
    links = new DebtorLinks(deps);
  });

  it('lien, code, session puis fin de session : réponses du contrat, dates ISO 8601', async () => {
    const { token } = await links.issue({ caseId: CASE_ID, debtorId: DEBTOR_ID });
    await expect(gateway(() => controller.openDebtorAccess({ token }))).resolves.toEqual({
      creditorName: 'SARL Bénin Propre',
      phoneMasked: '+229 01 ** ** ** 45',
      linkExpiresAt: '2026-12-20T09:00:00.000Z',
    });
    await expect(gateway(() => controller.sendDebtorAccessCode({ token }))).resolves.toEqual({
      channel: 'whatsapp',
      codeExpiresAt: '2026-11-20T09:10:00.000Z',
      retryAfterSeconds: 60,
    });
    const session = await gateway(() =>
      controller.verifyDebtorAccessCode({ token, code: notifier.lastCode() }),
    );
    expect(session).toEqual({
      sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionExpiresAt: '2026-11-20T09:30:00.000Z',
    });
    await expect(
      gateway(() => controller.endDebtorSession({}, withSession(session.sessionToken))),
    ).resolves.toEqual({ endedAt: NOW.toISOString() });
    expect(
      (await rejection(callSessionMethod('getDebtorCase', withSession(session.sessionToken)))).code,
    ).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
  });

  it.each(SESSION_METHODS)(
    '%s : session absente ou inconnue refusée (401), session valable transmise au cas d’usage',
    async (method) => {
      const { token } = await links.issue({ caseId: CASE_ID, debtorId: DEBTOR_ID });
      await gateway(() => controller.sendDebtorAccessCode({ token }));
      const { sessionToken } = await gateway(() =>
        controller.verifyDebtorAccessCode({ token, code: notifier.lastCode() }),
      );
      expect((await rejection(callSessionMethod(method))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
      expect((await rejection(callSessionMethod(method, withSession('A'.repeat(43))))).code).toBe(
        'RECOVERY_DEBTOR_SESSION_INVALID',
      );
      // Requête vide : refusée par le cas d’usage (R3) ou « pas encore disponible » (R4), jamais 401.
      expect((await rejection(callSessionMethod(method, withSession(sessionToken)))).code).not.toBe(
        'RECOVERY_DEBTOR_SESSION_INVALID',
      );
    },
  );
});
