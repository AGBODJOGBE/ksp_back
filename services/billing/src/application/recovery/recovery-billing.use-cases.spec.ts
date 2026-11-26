import { type RecoveryEventPayloads, type WalletEventPayloads } from '@ksp/contracts';
import { AppError } from '@ksp/platform';
import { as, asCustomer, asStaff, CUSTOMER_ID, ORGANIZATION_ID, STAFF_ID } from '../testing/fakes';
import { type RecoveryTestWorld, recoveryTestWorld } from '../testing/recovery-fakes';
import { DEFAULT_DEBIT_RETRY_DELAY_MS, WALLET_ERROR_RETRY_MS } from './commission-invoices.use-cases';
import { createRecoveryBillingUseCases } from './use-cases';

const at = (iso: string) => new Date(iso);
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });
const OTHER_ORG = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002';
const CASE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5000';
let counter = 0;
const nextId = (prefix: string) => `0192f1c4-7a2b-7c3d-${prefix}-${String(++counter).padStart(12, '0')}`;

function collected(
  overrides: Partial<RecoveryEventPayloads['recovery.payment.collected']> = {},
): RecoveryEventPayloads['recovery.payment.collected'] {
  return {
    caseId: CASE_ID,
    caseNumber: 'RC-000123',
    creditor: { type: 'organization', id: ORGANIZATION_ID },
    kind: 'b2b',
    collectionId: nextId('a000'),
    source: 'payment_link',
    gross: xof(100_000),
    allocatedCosts: xof(0),
    allocatedInterests: xof(0),
    allocatedPrincipal: xof(100_000),
    overpaid: xof(0),
    commission: xof(10_000),
    commissionSettlement: 'deducted',
    stage: 'amicable',
    amountDueAfter: xof(400_000),
    receivedAt: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

function debited(
  overrides: Partial<WalletEventPayloads['wallet.prepaid.debited']> = {},
): WalletEventPayloads['wallet.prepaid.debited'] {
  return {
    transactionId: nextId('b000'),
    holder: { type: 'user', id: CUSTOMER_ID },
    userId: CUSTOMER_ID,
    amount: xof(15_000),
    balanceAfter: xof(5_000),
    service: 'recovery',
    objectType: 'recovery_case_fee',
    objectId: CASE_ID,
    part: null,
    description: 'Frais de dossier RC-000123',
    debitedAt: '2026-11-20T09:00:00Z',
    ...overrides,
  };
}

function credited(
  overrides: Partial<WalletEventPayloads['wallet.prepaid.credited']> = {},
): WalletEventPayloads['wallet.prepaid.credited'] {
  return {
    transactionId: nextId('c000'),
    kind: 'top_up',
    topUpChannel: 'mobile_money_online',
    origin: 'payment',
    holder: { type: 'organization', id: ORGANIZATION_ID },
    userId: CUSTOMER_ID,
    amount: xof(20_000),
    balanceAfter: xof(20_000),
    description: 'Recharge Mobile Money',
    paymentId: nextId('d000'),
    refundedTransactionId: null,
    creditedAt: '2026-12-01T09:00:00Z',
    ...overrides,
  };
}

describe('Facturation du recouvrement (ADR-064)', () => {
  let world: RecoveryTestWorld;
  let useCases: ReturnType<typeof createRecoveryBillingUseCases>;
  const record = (payload = collected()) =>
    useCases.recordCollection.execute({ eventId: nextId('e000'), payload });
  const invoices = () =>
    [...world.recovery.invoices.values()].sort((a, b) => a.number.localeCompare(b.number));

  beforeEach(() => {
    world = recoveryTestWorld();
    useCases = createRecoveryBillingUseCases(world);
    world.clock.current = at('2026-11-30T23:00:00Z'); // 1er décembre 00:00 au Bénin
  });

  describe('encaissements (recovery.payment.collected)', () => {
    it('gardés une seule fois : même événement, ou même encaissement reçu deux fois', async () => {
      const payload = collected();
      const eventId = nextId('e000');
      expect(await useCases.recordCollection.execute({ eventId, payload })).toBe('recorded');
      expect(await useCases.recordCollection.execute({ eventId, payload })).toBe('duplicate');
      expect(await record(payload)).toBe('duplicate');
      expect(world.recovery.collections.get(payload.collectionId)).toMatchObject({
        creditor: { type: 'organization', id: ORGANIZATION_ID },
        caseNumber: 'RC-000123',
        gross: 100_000,
        commission: 10_000,
        settlement: 'deducted',
        invoiceId: null,
      });
    });
  });

  describe('émission mensuelle (le 1er, heure du Bénin, pour le mois écoulé)', () => {
    it('une facture par créancier, une ligne par encaissement, totaux hors taxe, série FCR', async () => {
      await record(collected({ receivedAt: '2026-11-20T10:00:00Z', caseNumber: 'RC-000124' }));
      await record(
        collected({
          receivedAt: '2026-11-05T10:00:00Z',
          source: 'direct_to_creditor',
          gross: xof(50_000),
          commission: xof(7_500),
          commissionSettlement: 'invoiced',
        }),
      );
      await record(
        collected({ creditor: { type: 'user', id: CUSTOMER_ID }, gross: xof(30_000), commission: xof(0) }),
      );

      const result = await useCases.issueCommissionInvoices.execute();

      expect(result).toEqual({ issued: 2, deferredOrganizationIds: [] });
      const [first, second] = invoices();
      // Les comptes d'abord, puis les organisations (en-tête lu dans identity).
      expect(first).toMatchObject({
        number: 'FCR-2026-000001',
        creditor: { type: 'user', id: CUSTOMER_ID },
        status: 'paid',
        organization: null,
        paidAt: at('2026-11-30T23:00:00Z'),
        totals: { collected: 30_000, deducted: 0, invoiced: 0, total: 0 },
        debit: { attempts: 0, nextAttemptAt: null },
      });
      expect(second).toMatchObject({
        number: 'FCR-2026-000002',
        creditor: { type: 'organization', id: ORGANIZATION_ID },
        status: 'pending_payment',
        periodStart: at('2026-10-31T23:00:00Z'),
        periodEnd: at('2026-11-30T23:00:00Z'),
        organization: { legalName: 'SARL Bénin Propre', ifu: '3201912345678' },
        totals: { collected: 150_000, deducted: 10_000, invoiced: 7_500, total: 17_500 },
        paidAt: null,
        debit: { attempts: 0, nextAttemptAt: at('2026-11-30T23:00:00Z') },
      });
      expect(second!.lines.map((line) => [line.position, line.caseNumber, line.settlement])).toEqual([
        [1, 'RC-000123', 'invoiced'],
        [2, 'RC-000124', 'deducted'],
      ]);
      expect(second!.lines[0]).toMatchObject({
        source: 'direct_to_creditor',
        gross: 50_000,
        commission: 7_500,
      });
      // Événement : identifiants et montants seulement, mois AAAA-MM.
      const event = world.recorder.events.find(
        (each) => each.type === 'billing.commission_invoice.issued' && each.payload.invoiceId === second!.id,
      );
      expect(event?.payload).toEqual({
        invoiceId: second!.id,
        invoiceNumber: 'FCR-2026-000002',
        creditor: { type: 'organization', id: ORGANIZATION_ID },
        period: '2026-11',
        totalCollected: xof(150_000),
        commissionDeducted: xof(10_000),
        commissionInvoiced: xof(7_500),
        commissionTotal: xof(17_500),
        issuedAt: '2026-11-30T23:00:00.000Z',
      });
    });

    it('mois du Bénin : 1er novembre 00:30 compte pour novembre, 1er décembre 00:30 pour décembre', async () => {
      const inNovember = collected({ receivedAt: '2026-10-31T23:30:00Z' });
      const inDecember = collected({ receivedAt: '2026-11-30T23:30:00Z' });
      await record(inNovember);
      await record(inDecember);
      world.clock.current = at('2026-12-01T06:00:00Z');
      await useCases.issueCommissionInvoices.execute();
      expect(invoices()).toHaveLength(1);
      expect(invoices()[0]!.lines.map((line) => line.collectionId)).toEqual([inNovember.collectionId]);
      expect(world.recovery.collections.get(inDecember.collectionId)!.invoiceId).toBeNull();
    });

    it('idempotente ; un encaissement arrivé après l’émission part sur la facture suivante', async () => {
      await record();
      await useCases.issueCommissionInvoices.execute();
      expect((await useCases.issueCommissionInvoices.execute()).issued).toBe(0);
      const late = collected({ receivedAt: '2026-11-28T10:00:00Z' });
      await record(late);
      expect((await useCases.issueCommissionInvoices.execute()).issued).toBe(0);
      world.clock.current = at('2026-12-31T23:00:00Z');
      await useCases.issueCommissionInvoices.execute();
      const december = invoices()[1]!;
      expect(december).toMatchObject({ number: 'FCR-2026-000002', periodStart: at('2026-11-30T23:00:00Z') });
      expect(december.lines.map((line) => line.collectionId)).toEqual([late.collectionId]);
    });

    it('numéro continu par année du mois facturé : décembre émis en janvier garde 2026', async () => {
      await record(collected({ receivedAt: '2026-12-15T10:00:00Z' }));
      world.clock.current = at('2026-12-31T23:00:00Z');
      await useCases.issueCommissionInvoices.execute();
      await record(collected({ receivedAt: '2027-01-15T10:00:00Z' }));
      world.clock.current = at('2027-01-31T23:00:00Z');
      await useCases.issueCommissionInvoices.execute();
      expect(invoices().map((invoice) => invoice.number)).toEqual(['FCR-2026-000001', 'FCR-2027-000001']);
    });

    it('organisation introuvable : reportée ; identity indisponible : comptes facturés, organisations au passage suivant', async () => {
      await record(collected({ creditor: { type: 'organization', id: OTHER_ORG } }));
      expect(await useCases.issueCommissionInvoices.execute()).toEqual({
        issued: 0,
        deferredOrganizationIds: [OTHER_ORG],
      });

      await record(collected({ creditor: { type: 'user', id: CUSTOMER_ID } }));
      await record(collected());
      world.organizations.unavailable = true;
      await expect(useCases.issueCommissionInvoices.execute()).rejects.toThrow('identity indisponible');
      expect(invoices().map((invoice) => invoice.creditor.type)).toEqual(['user']);
      world.organizations.unavailable = false;
      expect((await useCases.issueCommissionInvoices.execute()).issued).toBe(1);
    });
  });

  describe('débit automatique de la commission « invoiced »', () => {
    const invoiced = (commission: number) =>
      record(
        collected({
          commission: xof(commission),
          commissionSettlement: 'invoiced',
          source: 'direct_to_creditor',
        }),
      );

    it('débitée du portefeuille du créancier à l’émission : facture réglée, clé stable', async () => {
      await invoiced(12_000);
      world.wallet.balances.set(ORGANIZATION_ID, 20_000);
      await useCases.issueCommissionInvoices.execute();
      expect(await useCases.debitCommissionInvoices.execute()).toEqual({ paid: 1, failures: [] });
      const [invoice] = invoices();
      const debit = world.wallet.debits.get(`billing_commission_invoice:${invoice!.id}`);
      expect(debit).toMatchObject({ amount: 12_000, holderId: ORGANIZATION_ID });
      expect(invoice).toMatchObject({
        status: 'paid',
        paidAt: at('2026-11-30T23:00:00Z'),
        walletTransactionId: debit!.transactionId,
        debit: { attempts: 1, nextAttemptAt: null, lastFailure: null },
      });
      expect(world.wallet.balances.get(ORGANIZATION_ID)).toBe(8_000);
      // Rien de plus à débiter.
      expect(await useCases.debitCommissionInvoices.execute()).toEqual({ paid: 0, failures: [] });
    });

    it('solde insuffisant : reste due, montant manquant, nouvel essai un jour plus tard, puis réglée', async () => {
      await invoiced(12_000);
      world.wallet.balances.set(ORGANIZATION_ID, 2_000);
      await useCases.issueCommissionInvoices.execute();
      const first = await useCases.debitCommissionInvoices.execute();
      expect(first.paid).toBe(0);
      expect(first.failures).toEqual([
        expect.objectContaining({ reason: 'insufficient_funds', code: 'WALLET_INSUFFICIENT_FUNDS' }),
      ]);
      expect(invoices()[0]).toMatchObject({
        status: 'pending_payment',
        debit: {
          attempts: 1,
          lastAttemptAt: at('2026-11-30T23:00:00Z'),
          nextAttemptAt: new Date(at('2026-11-30T23:00:00Z').getTime() + DEFAULT_DEBIT_RETRY_DELAY_MS),
          lastFailure: 'insufficient_funds',
          missingAmount: 10_000,
        },
      });

      // Recharge : rien avant l'échéance du nouvel essai.
      world.wallet.balances.set(ORGANIZATION_ID, 15_000);
      world.clock.current = at('2026-12-01T12:00:00Z');
      expect(await useCases.debitCommissionInvoices.execute()).toEqual({ paid: 0, failures: [] });
      world.clock.current = at('2026-12-01T23:00:00Z');
      expect((await useCases.debitCommissionInvoices.execute()).paid).toBe(1);
      expect(invoices()[0]).toMatchObject({
        status: 'paid',
        paidAt: at('2026-12-01T23:00:00Z'),
        debit: { attempts: 2, lastFailure: null, missingAmount: null, nextAttemptAt: null },
      });
    });

    it('délai réglable ; panne de wallet : nouvel essai un quart d’heure plus tard', async () => {
      useCases = createRecoveryBillingUseCases(world, { debitRetryDelayMs: 6 * 3_600_000 });
      await invoiced(12_000);
      await useCases.issueCommissionInvoices.execute();
      await useCases.debitCommissionInvoices.execute();
      expect(invoices()[0]!.debit.nextAttemptAt).toEqual(at('2026-12-01T05:00:00Z'));

      world.clock.current = at('2026-12-01T05:00:00Z');
      world.wallet.debit = () =>
        Promise.reject(AppError.unavailable('WALLET_UNAVAILABLE', 'wallet en panne'));
      const outcome = await useCases.debitCommissionInvoices.execute();
      expect(outcome.failures).toEqual([
        expect.objectContaining({ reason: 'wallet_error', code: 'WALLET_UNAVAILABLE' }),
      ]);
      expect(invoices()[0]!.debit).toMatchObject({
        attempts: 2,
        lastFailure: 'wallet_error',
        missingAmount: null,
        nextAttemptAt: new Date(at('2026-12-01T05:00:00Z').getTime() + WALLET_ERROR_RETRY_MS),
      });
    });
  });

  describe('nouvel essai dès un crédit du portefeuille (wallet.prepaid.credited)', () => {
    const invoiced = (commission: number) =>
      record(
        collected({
          commission: xof(commission),
          commissionSettlement: 'invoiced',
          source: 'direct_to_creditor',
        }),
      );
    const credit = (payload = credited()) =>
      useCases.retryCommissionDebitsOnWalletCredit.execute({ payload });
    const debitCalls = () => world.wallet.debits.size;

    /** Facture de commission de l'organisation, due après un premier essai refusé (solde insuffisant). */
    async function dueInvoice() {
      await invoiced(12_000);
      world.wallet.balances.set(ORGANIZATION_ID, 2_000);
      await useCases.issueCommissionInvoices.execute();
      await useCases.debitCommissionInvoices.execute();
      expect(invoices()[0]).toMatchObject({ status: 'pending_payment', debit: { attempts: 1 } });
    }

    it('aucune facture due : rien, sans verrou ni appel à wallet', async () => {
      expect(await credit()).toEqual({ due: 0, paid: 0, failures: [] });
      // Facture réglée dès l'émission (commission retenue) : rien non plus.
      await record();
      await useCases.issueCommissionInvoices.execute();
      expect(await credit()).toEqual({ due: 0, paid: 0, failures: [] });
      expect(world.debitLock.runs).toBe(0);
      expect(debitCalls()).toBe(0);
    });

    it('facture due puis recharge : débitée tout de suite, même clé, sans attendre le nouvel essai', async () => {
      await dueInvoice();
      world.wallet.balances.set(ORGANIZATION_ID, 15_000);
      world.clock.current = at('2026-12-01T09:00:00Z');
      expect(await credit()).toEqual({ due: 1, paid: 1, failures: [] });
      const [invoice] = invoices();
      const debit = world.wallet.debits.get(`billing_commission_invoice:${invoice!.id}`);
      expect(debit).toMatchObject({ amount: 12_000, holderId: ORGANIZATION_ID });
      expect(invoice).toMatchObject({
        status: 'paid',
        paidAt: at('2026-12-01T09:00:00Z'),
        walletTransactionId: debit!.transactionId,
        debit: { attempts: 2, nextAttemptAt: null, lastFailure: null, missingAmount: null },
      });
      expect(world.wallet.balances.get(ORGANIZATION_ID)).toBe(3_000);
      expect(world.debitLock.runs).toBe(1);
      // La tâche planifiée n'a plus rien à débiter.
      world.clock.current = at('2026-12-01T23:00:00Z');
      expect(await useCases.debitCommissionInvoices.execute()).toEqual({ paid: 0, failures: [] });
    });

    it('idempotent : le même crédit reçu deux fois ne débite rien de plus', async () => {
      await dueInvoice();
      world.wallet.balances.set(ORGANIZATION_ID, 50_000);
      const payload = credited();
      expect((await credit(payload)).paid).toBe(1);
      expect(await credit(payload)).toEqual({ due: 0, paid: 0, failures: [] });
      expect(debitCalls()).toBe(1);
      expect(world.wallet.balances.get(ORGANIZATION_ID)).toBe(38_000);
    });

    it('recharge insuffisante : reste due, montant manquant, nouvel essai planifié', async () => {
      await dueInvoice();
      world.wallet.balances.set(ORGANIZATION_ID, 5_000);
      world.clock.current = at('2026-12-01T09:00:00Z');
      const outcome = await credit();
      expect(outcome).toMatchObject({ due: 1, paid: 0 });
      expect(outcome.failures).toEqual([
        expect.objectContaining({ reason: 'insufficient_funds', code: 'WALLET_INSUFFICIENT_FUNDS' }),
      ]);
      expect(invoices()[0]).toMatchObject({
        status: 'pending_payment',
        debit: {
          attempts: 2,
          lastFailure: 'insufficient_funds',
          missingAmount: 7_000,
          nextAttemptAt: new Date(at('2026-12-01T09:00:00Z').getTime() + DEFAULT_DEBIT_RETRY_DELAY_MS),
        },
      });
    });

    it('crédit d’un autre titulaire : rien ; le compte personnel du membre n’est pas l’organisation', async () => {
      await dueInvoice();
      world.wallet.balances.set(ORGANIZATION_ID, 50_000);
      expect(await credit(credited({ holder: { type: 'user', id: CUSTOMER_ID } }))).toEqual({
        due: 0,
        paid: 0,
        failures: [],
      });
      expect(await credit(credited({ holder: { type: 'organization', id: OTHER_ORG } }))).toEqual({
        due: 0,
        paid: 0,
        failures: [],
      });
      expect(invoices()[0]!.status).toBe('pending_payment');
    });

    it('passage de débit en cours (verrou pris) : erreur, rien n’est débité ; repris ensuite', async () => {
      await dueInvoice();
      world.wallet.balances.set(ORGANIZATION_ID, 15_000);
      world.debitLock.held = true;
      await expect(credit()).rejects.toThrow(/Débit des commissions en cours/);
      expect(invoices()[0]).toMatchObject({ status: 'pending_payment', debit: { attempts: 1 } });
      expect(debitCalls()).toBe(0);
      // Message rejoué par la file de reprise, le passage terminé.
      world.debitLock.held = false;
      expect((await credit()).paid).toBe(1);
    });

    it('facture réglée par le passage qui tenait le verrou : relue sous le verrou, rien de plus', async () => {
      await dueInvoice();
      world.wallet.balances.set(ORGANIZATION_ID, 15_000);
      const tryRun = world.debitLock.tryRun.bind(world.debitLock);
      world.debitLock.tryRun = async <T>(run: () => Promise<T>) => {
        // La tâche planifiée règle la facture juste avant que le verrou ne soit libéré.
        world.clock.current = at('2026-12-01T23:00:00Z');
        await useCases.debitCommissionInvoices.execute();
        return tryRun(run);
      };
      expect(await credit()).toEqual({ due: 0, paid: 0, failures: [] });
      expect(debitCalls()).toBe(1);
      expect(invoices()[0]).toMatchObject({ status: 'paid', debit: { attempts: 2 } });
    });
  });

  describe('reçus des frais de dossier (wallet.prepaid.debited)', () => {
    const receipt = (payload = debited(), eventId = nextId('e000')) =>
      useCases.recordFeeReceipt.execute({ eventId, payload });
    const receipts = () =>
      [...world.recovery.receipts.values()].sort((a, b) => a.number.localeCompare(b.number));

    it('un reçu par débit de frais de recovery, série RFD ; tout autre débit est ignoré', async () => {
      expect(await receipt()).toBe('recorded');
      expect(
        await receipt(
          debited({
            objectType: 'recovery_study_fee',
            description: "Forfait d'étude du dossier RC-000124",
            holder: { type: 'organization', id: ORGANIZATION_ID },
          }),
        ),
      ).toBe('recorded');
      expect(await receipt(debited({ service: 'cleaning', objectType: 'cleaning_session' }))).toBe('ignored');
      expect(await receipt(debited({ objectType: 'recovery_provision' }))).toBe('ignored');
      expect(await receipt(debited({ service: 'billing', objectType: 'billing_commission_invoice' }))).toBe(
        'ignored',
      );
      expect(receipts().map((each) => [each.number, each.kind, each.caseNumber, each.payer.type])).toEqual([
        ['RFD-2026-000001', 'case_fee', 'RC-000123', 'user'],
        ['RFD-2026-000002', 'study_fee', 'RC-000124', 'organization'],
      ]);
      expect(receipts()[0]).toMatchObject({
        amount: 15_000,
        caseId: CASE_ID,
        paidAt: at('2026-11-20T09:00:00Z'),
      });
    });

    it('idempotent par transaction ; année du paiement au Bénin ; libellé sans numéro de dossier', async () => {
      const payload = debited();
      const eventId = nextId('e000');
      expect(await receipt(payload, eventId)).toBe('recorded');
      expect(await receipt(payload, eventId)).toBe('duplicate');
      expect(await receipt(payload)).toBe('duplicate');
      expect(
        await receipt(debited({ debitedAt: '2026-12-31T23:30:00Z', description: 'Frais de dossier' })),
      ).toBe('recorded');
      expect(receipts().map((each) => [each.number, each.caseNumber])).toEqual([
        ['RFD-2026-000001', 'RC-000123'],
        ['RFD-2027-000001', null],
      ]);
    });

    it('« Mes reçus » : compte ou organisation active, filtre par dossier', async () => {
      await receipt();
      await receipt(debited({ holder: { type: 'organization', id: ORGANIZATION_ID } }));
      await receipt(debited({ objectId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5999' }));
      const personal = await as(CUSTOMER_ID, () =>
        useCases.listMyFeeReceipts.execute({ page: { limit: 20, cursor: null }, caseId: '' }),
      );
      expect(personal.items).toHaveLength(2);
      const filtered = await as(CUSTOMER_ID, () =>
        useCases.listMyFeeReceipts.execute({ page: { limit: 20, cursor: null }, caseId: CASE_ID }),
      );
      expect(filtered.items).toHaveLength(1);
      const organization = await asCustomer(() =>
        useCases.listMyFeeReceipts.execute({ page: { limit: 20, cursor: null }, caseId: '' }),
      );
      expect(organization.items.map((each) => each.payer)).toEqual([
        { type: 'organization', id: ORGANIZATION_ID },
      ]);
      await expect(
        as(CUSTOMER_ID, () =>
          useCases.listMyFeeReceipts.execute({ page: { limit: 20, cursor: null }, caseId: 'x' }),
        ),
      ).rejects.toMatchObject({ code: 'BILLING_VALIDATION_FAILED' });
    });
  });

  describe('accès', () => {
    const page = { limit: 20, cursor: null };
    beforeEach(async () => {
      await record(collected({ commission: xof(5_000), commissionSettlement: 'invoiced' }));
      await record(collected({ creditor: { type: 'user', id: CUSTOMER_ID } }));
      await useCases.issueCommissionInvoices.execute();
    });
    const byCreditor = (type: string) => invoices().find((invoice) => invoice.creditor.type === type)!;

    it('client : son compte en personnel, son organisation active sinon ; autre créancier : 404', async () => {
      const mine = await as(CUSTOMER_ID, () =>
        useCases.listMyCommissionInvoices.execute({ page, status: '', period: '' }),
      );
      expect(mine.items.map((invoice) => invoice.creditor.type)).toEqual(['user']);
      const organization = await asCustomer(() =>
        useCases.listMyCommissionInvoices.execute({ page, status: 'pending_payment', period: '2026-11' }),
      );
      expect(organization.items.map((invoice) => invoice.id)).toEqual([byCreditor('organization').id]);
      // Membre lecteur : la lecture reste permise.
      const viewer = await as(
        CUSTOMER_ID,
        () => useCases.getMyCommissionInvoice.execute(byCreditor('organization').id),
        { activeContext: ORGANIZATION_ID, orgRole: 'org_viewer' },
      );
      expect(viewer.number).toBe(byCreditor('organization').number);
      await expect(
        as(CUSTOMER_ID, () => useCases.getMyCommissionInvoice.execute(byCreditor('organization').id)),
      ).rejects.toMatchObject({ code: 'BILLING_INVOICE_NOT_FOUND' });
      await expect(
        asCustomer(() => useCases.getMyCommissionInvoice.execute(byCreditor('user').id), OTHER_ORG),
      ).rejects.toMatchObject({ code: 'BILLING_INVOICE_NOT_FOUND' });
      const october = await asCustomer(() =>
        useCases.listMyCommissionInvoices.execute({ page, status: '', period: '2026-10' }),
      );
      expect(october.items).toEqual([]);
      await expect(
        asCustomer(() => useCases.listMyCommissionInvoices.execute({ page, status: '', period: '2026-13' })),
      ).rejects.toMatchObject({ code: 'BILLING_VALIDATION_FAILED', details: { field: 'period' } });
      await expect(
        asCustomer(() => useCases.listMyCommissionInvoices.execute({ page, status: 'overdue', period: '' })),
      ).rejects.toMatchObject({ code: 'BILLING_VALIDATION_FAILED', details: { field: 'status' } });
    });

    it('back-office : finance, super administrateur, administration du recouvrement ; double authentification', async () => {
      for (const role of ['finance_officer', 'super_admin', 'recovery_admin']) {
        const all = await asStaff(
          () => useCases.listCommissionInvoices.execute({ page, status: '', period: '', creditorId: '' }),
          role,
        );
        expect(all.items).toHaveLength(2);
      }
      const filtered = await asStaff(() =>
        useCases.listCommissionInvoices.execute({
          page,
          status: '',
          period: '2026-11',
          creditorId: CUSTOMER_ID,
        }),
      );
      expect(filtered.items.map((invoice) => invoice.creditor.id)).toEqual([CUSTOMER_ID]);
      expect(
        (
          await asStaff(
            () => useCases.getCommissionInvoice.execute(byCreditor('organization').id),
            'recovery_admin',
          )
        ).number,
      ).toBe(byCreditor('organization').number);
      await expect(asStaff(() => useCases.getCommissionInvoice.execute(CASE_ID))).rejects.toMatchObject({
        code: 'BILLING_INVOICE_NOT_FOUND',
      });
      await expect(
        asStaff(
          () => useCases.listCommissionInvoices.execute({ page, status: '', period: '', creditorId: '' }),
          'cleaning_admin',
        ),
      ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
      await expect(
        as(STAFF_ID, () => useCases.getCommissionInvoice.execute(byCreditor('user').id), {
          roles: ['finance_officer'],
          mfa: false,
        }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_REQUIRED' });
      // Méthodes du client et du back-office : la gateway seule.
      await expect(
        as(STAFF_ID, () => useCases.getCommissionInvoice.execute(byCreditor('user').id), {
          roles: ['finance_officer'],
          mfa: true,
          callerService: 'recovery',
        }),
      ).rejects.toMatchObject({ code: 'BILLING_CALLER_FORBIDDEN' });
    });

    it('suppression du compte : une facture de commission due bloque ; réglée, plus rien', async () => {
      const userInvoice = byCreditor('user');
      expect(userInvoice.status).toBe('paid');
      expect(
        await as(
          CUSTOMER_ID,
          () => useCases.hasPendingObligations.execute({ userId: CUSTOMER_ID, organizationId: '' }),
          {
            callerService: 'identity',
          },
        ),
      ).toEqual([]);
      // Organisation désignée par identity : sa facture due compte.
      const withOrganization = await as(
        CUSTOMER_ID,
        () =>
          useCases.hasPendingObligations.execute({ userId: CUSTOMER_ID, organizationId: ORGANIZATION_ID }),
        { callerService: 'identity' },
      );
      expect(withOrganization).toEqual([
        {
          kind: 'unpaid_invoice',
          reference: byCreditor('organization').number,
          description: expect.stringContaining('5 000 FCFA hors taxe'),
        },
      ]);
      await expect(
        as(
          CUSTOMER_ID,
          () => useCases.hasPendingObligations.execute({ userId: CUSTOMER_ID, organizationId: '' }),
          {
            callerService: 'cleaning',
          },
        ),
      ).rejects.toMatchObject({ code: 'BILLING_CALLER_FORBIDDEN' });

      // Compte créancier avec une commission due.
      await record(
        collected({
          creditor: { type: 'user', id: CUSTOMER_ID },
          receivedAt: '2026-12-03T10:00:00Z',
          commission: xof(2_000),
          commissionSettlement: 'invoiced',
        }),
      );
      world.clock.current = at('2026-12-31T23:00:00Z');
      await useCases.issueCommissionInvoices.execute();
      const pending = await as(
        CUSTOMER_ID,
        () => useCases.hasPendingObligations.execute({ userId: CUSTOMER_ID, organizationId: '' }),
        { callerService: 'identity' },
      );
      expect(pending.map((obligation) => obligation.reference)).toEqual(['FCR-2026-000003']);
    });
  });
});
