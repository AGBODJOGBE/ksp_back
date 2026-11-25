import { type CaseInputData } from '../cases/case-input';
import { type RecoveryCaseRecord } from '../cases/ports';
import { caseWorld, submittedCase, SUPERVISOR_ID } from './case-scenarios';
import { asStaff, CREDITOR_ID } from './fakes';
import {
  type MemoryDebtorUploads,
  type MemoryMoneyStore,
  MemoryNotifier,
  MemoryPaymentLinks,
  MoneyWallet,
} from './money-fakes';

/**
 * Monde de test de l'argent (lot R3) : celui des dossiers, avec un portefeuille qui crédite les
 * encaissements, des liens de paiement, des messages au débiteur et le dépôt de l'argent en mémoire.
 */
export const FINANCE_A = '0192f1c4-0000-7000-8000-00000000f0a1';
export const FINANCE_B = '0192f1c4-0000-7000-8000-00000000f0b2';
export const CREDITOR_NAME = 'Awa Créancière';

export function moneyWorld() {
  const world = caseWorld();
  const wallet = new MoneyWallet(world.wallet);
  const paymentLinks = new MemoryPaymentLinks();
  const notifier = new MemoryNotifier();
  world.deps.wallet = wallet;
  world.deps.paymentLinks = paymentLinks;
  world.deps.notifier = notifier;
  world.directory.users.set(CREDITOR_ID, CREDITOR_NAME);
  return {
    ...world,
    moneyWallet: wallet,
    paymentLinks,
    notifier,
    money: world.deps.money as MemoryMoneyStore,
    uploads: world.deps.debtorUploads as MemoryDebtorUploads,
  };
}

export type MoneyWorld = ReturnType<typeof moneyWorld>;

/** Dossier accepté (actif, étape de notification) : 750 000 FCFA dus, commission amiable de 10 %. */
export async function activeCase(
  world: MoneyWorld,
  key = 'case-key-0001',
  change: Partial<CaseInputData> = {},
): Promise<RecoveryCaseRecord> {
  const submitted = await submittedCase(world, key, change);
  const view = await asStaff(SUPERVISOR_ID, ['recovery_supervisor'], () =>
    world.useCases.assessCase.execute({
      caseId: submitted.record.id,
      idempotencyKey: `assess-${key}`,
      decision: 'accept',
      note: '',
      agentUserId: '',
      rejectionReason: '',
    }),
  );
  return view.record;
}

/** Débiteur principal d'un dossier, tel que la session le donne. */
export const debtorScope = (record: RecoveryCaseRecord) => ({
  caseId: record.id,
  debtorId: record.debtors[0]!.id,
});

/** Membre de la finance, double authentification de moins de 10 minutes. */
export const asFinance = <T>(userId: string, fn: () => Promise<T>, mfaAgeSeconds = 60) =>
  asStaff(userId, ['finance_officer'], fn, mfaAgeSeconds);

let paymentCounter = 0;

/** Événement `payment.link.paid` du dernier lien demandé par le débiteur. */
export async function payLink(world: MoneyWorld, record: RecoveryCaseRecord, amount?: number) {
  const request = [...world.money.paymentRequests.values()]
    .filter((candidate) => candidate.caseId === record.id && candidate.status === 'active')
    .pop();
  if (!request) throw new Error('Aucun lien de paiement actif.');
  paymentCounter += 1;
  const suffix = paymentCounter.toString(16).padStart(12, '0');
  world.paymentLinks.markPaid(request.paymentLinkId!, '2026-11-20T10:00:00.000Z');
  return world.useCases.recordLinkPayment.execute({
    eventId: `0192f1c4-0000-7000-8e00-${suffix}`,
    paymentId: `0192f1c4-0000-7000-8f00-${suffix}`,
    subjectType: 'recovery_payment_request',
    subjectId: request.id,
    amount: amount ?? request.amount,
    providerReference: `FEDA-${suffix}`,
    paidAt: '2026-11-20T10:00:00.000Z',
  });
}
