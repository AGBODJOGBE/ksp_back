import { type RecoveryCaseRecord } from '../cases/ports';
import { type DebtorAccessPorts } from '../debtor-access/debtor-access.ports';
import { CaseBackedDebtorReader } from '../testing/amicable-fakes';
import { SUPERVISOR_ID } from '../testing/case-scenarios';
import { type FakeDebtorSecrets, type MemoryDebtorAccessStore } from '../testing/debtor-access.fakes';
import { asService, asStaff, rejection } from '../testing/fakes';
import { activeCase, debtorScope, moneyWorld, type MoneyWorld, payLink } from '../testing/money-scenarios';

const DAY_MS = 86_400_000;

/** Remise de 10 % au plus permise par le créancier : 700 000 FCFA tout de suite contre 750 000 dus. */
const SCALE = {
  acceptsPaymentPlan: true,
  maxDurationMonths: 12,
  minFirstPaymentBps: 1_000,
  firstPaymentWithinDays: 15,
  minInstallment: 25_000,
  maxDiscountBps: 1_000,
};

describe('dossier clos par une remise payée : attestation et espace du débiteur en lecture seule', () => {
  let world: MoneyWorld;
  let record: RecoveryCaseRecord;

  beforeEach(async () => {
    world = moneyWorld();
    world.deps.debtorAccess.reader = new CaseBackedDebtorReader(
      world.deps.cases,
      world.deps.personalData,
      world.money,
    );
    record = await activeCase(world, 'case-key-settle', { planScale: SCALE });
    const settlement = await asStaff(SUPERVISOR_ID, ['recovery_supervisor'], () =>
      world.useCases.proposeSettlement.execute({
        caseId: record.id,
        idempotencyKey: 'settle-key-0001',
        payNow: 700_000,
        validUntil: '2026-11-30',
        note: '',
      }),
    );
    await world.useCases.createDebtorPayment.execute({
      ...debtorScope(record),
      idempotencyKey: 'pay-settle-0001',
      amount: null,
      settlementId: settlement.id,
    });
    await payLink(world, record);
  });

  const current = async () => (await world.deps.cases.find(record.id))!;
  const closureOf = async () => (await world.money.money(record.id)).closure!;
  /** Lien envoyé avec l'attestation : son jeton est le dernier segment de l'adresse. */
  const certificateLink = () => {
    const sent = [...world.notifier.sent.values()].find((m) => m.message === 'settlement_certificate')!;
    return sent.variables['link']!;
  };

  /** Session du débiteur ouverte par le lien et le code reçu (ADR-061). */
  async function openSession(token: string) {
    (world.deps.debtorAccess.secrets as FakeDebtorSecrets).nextCodes.push('424242');
    return asService('gateway', async () => {
      await world.useCases.sendDebtorAccessCode.execute({ token });
      const session = await world.useCases.verifyDebtorAccessCode.execute({ token, code: '424242' });
      return session.sessionToken;
    });
  }
  const resolve = (sessionToken: string, use: 'read' | 'write') =>
    asService('gateway', () => world.useCases.resolveDebtorSession.execute({ sessionToken, use }));

  it('accord transactionnel exécuté : attestation avec le solde abandonné, envoyée avec un lien', async () => {
    expect(await current()).toMatchObject({ status: 'closed', closureReason: 'settlement_executed' });
    const certificate = world.documents.generated.get(`recovery:settlement-certificate:${record.id}`)!;
    expect(certificate.variables).toMatchObject({
      closure: 'settlement_executed',
      waivedAmount: 50_000,
      totalPaid: 700_000,
      settledOn: '2026-11-20',
    });
    const closure = await closureOf();
    expect(closure).toMatchObject({ certificateDocumentId: certificate.id });
    expect(closure.completedAt).not.toBeNull();
    expect((await current()).documents).toContainEqual(
      expect.objectContaining({
        kind: 'settlement_certificate',
        documentId: certificate.id,
        visibleToDebtor: true,
      }),
    );
    const closed = world.deps.cases.events.filter((event) => event.type === 'recovery.case.closed');
    expect(closed.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        reason: 'settlement_executed',
        settlementCertificateDocumentId: certificate.id,
      }),
    ]);
    expect(certificateLink()).toMatch(/^https:\/\/ksp\.bj\/recouvrement\/[A-Za-z0-9_-]{43}$/);
  });

  it('relevé du mois : dossier clos par l’accord, plus rien à payer par le débiteur', async () => {
    world.deps.clock.current = new Date('2026-11-30T23:30:00.000Z');
    expect(await world.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 1, failed: 0 });
    const statement = world.documents.generated.get(`recovery:statement:${record.id}:2026-11`)!;
    expect(statement.variables['situation']).toEqual({
      status: 'Clos : accord transactionnel exécuté',
      collectedToDate: 700_000,
      outstanding: 0,
    });
  });

  it('lecture seule 30 jours : situation et documents, ni paiement ni contestation ; puis plus rien', async () => {
    const token = certificateLink().split('/').pop()!;
    const debtorId = record.debtors[0]!.id;
    const store = world.deps.debtorAccess.store as MemoryDebtorAccessStore;
    const closedAt = (await closureOf()).closedAt;
    expect(store.activeOf(debtorId)!.link.expiresAt).toEqual(new Date(closedAt.getTime() + 30 * DAY_MS));

    const sessionToken = await openSession(token);
    expect(await resolve(sessionToken, 'read')).toMatchObject({ ...debtorScope(record), readOnly: true });
    expect(await rejection(resolve(sessionToken, 'write'))).toMatchObject({
      code: 'RECOVERY_INVALID_TRANSITION',
      details: { status: 'closed' },
    });

    const view = await world.useCases.getDebtorCase.execute(debtorScope(record));
    expect(view.status).toBe('closed');
    expect(view.pendingPaymentUrl).toBe('');
    expect(view.planScale).toMatchObject({ acceptsPaymentPlan: false, maxDiscountBps: 0 });
    expect(view.documents.map((document) => document.kind).sort()).toEqual([
      'receipt',
      'settlement_certificate',
    ]);
    expect(view.certificateDocumentId).not.toBe('');
    const url = await world.useCases.getDebtorDocumentUrl.execute({
      ...debtorScope(record),
      documentId: view.certificateDocumentId,
    });
    expect(url.url).toContain(view.certificateDocumentId);
    // Pièce choisie par KSP pendant la procédure : plus montrée après la clôture.
    const stored = world.deps.cases.cases.get(record.id)!;
    stored.documents.push({
      id: '0192f1c4-0000-7000-8000-00000000d0c1',
      kind: 'evidence',
      label: 'Facture',
      fileId: '0192f1c4-0000-7000-8000-00000000f1c1',
      documentId: null,
      visibleToPartner: false,
      visibleToDebtor: true,
      addedBy: { type: 'agent', id: SUPERVISOR_ID },
      addedAt: closedAt,
    });
    expect(
      await rejection(
        world.useCases.getDebtorDocumentUrl.execute({
          ...debtorScope(record),
          documentId: '0192f1c4-0000-7000-8000-00000000f1c1',
        }),
      ),
    ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED' });

    // 29 jours après la clôture : le lien s'ouvre encore, en lecture seule ; 30 jours : plus rien.
    world.deps.clock.current = new Date(closedAt.getTime() + 29 * DAY_MS);
    const later = await openSession(token);
    expect(await resolve(later, 'read')).toMatchObject({ readOnly: true });
    world.deps.clock.current = new Date(closedAt.getTime() + 30 * DAY_MS);
    expect(await rejection(resolve(later, 'read'))).toMatchObject({
      code: 'RECOVERY_DEBTOR_SESSION_INVALID',
    });
    expect(
      await rejection(asService('gateway', () => world.useCases.openDebtorAccess.execute({ token }))),
    ).toMatchObject({ code: 'RECOVERY_DEBTOR_LINK_INVALID' });
  });

  it('sans accès après la clôture (0 jour) : liens révoqués comme avant, adresse du portail dans le message', async () => {
    const other = moneyWorld();
    (other.deps.debtorAccess as DebtorAccessPorts).closedAccessDays = 0;
    other.deps.debtorAccess.reader = new CaseBackedDebtorReader(
      other.deps.cases,
      other.deps.personalData,
      other.money,
    );
    const paid = await activeCase(other, 'case-key-paid');
    const debtorId = paid.debtors[0]!.id;
    await other.useCases.createDebtorPayment.execute({
      ...debtorScope(paid),
      idempotencyKey: 'pay-full-0001',
      amount: 750_000,
      settlementId: '',
    });
    await payLink(other, paid);
    expect((await other.deps.cases.find(paid.id))!.status).toBe('closed');
    expect((other.deps.debtorAccess.store as MemoryDebtorAccessStore).activeOf(debtorId)).toBeUndefined();
    expect(other.notifier.sent.get(`settlement-certificate:${paid.id}`)!.variables['link']).toBe(
      'https://ksp.bj/recouvrement',
    );
  });
});
