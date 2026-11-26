import { runWithContext } from '@ksp/platform';
import { type RecoveryCaseRecord } from '../cases/ports';
import { type PartnerInputData } from '../litigation/partners.use-cases';
import {
  activeCase,
  amicableWorld,
  asLegal,
  asSupervisor,
  at,
  caseOf,
  LEGAL_OFFICER_ID,
} from './amicable-scenarios';
import { asCreditor, CREDITOR_ID } from './fakes';
import { type MemoryLitigationStore } from './litigation-fakes';
import { MemoryPaymentLinks, type MemoryMoneyStore, MoneyWallet } from './money-fakes';

/**
 * Monde de test du contentieux (lot R5) : celui de la procédure amiable, avec un portefeuille qui
 * crédite les encaissements, des liens de paiement et le dépôt du contentieux en mémoire.
 */

export const BAILIFF_USER_ID = '0192f1c4-0000-7000-8000-0000000ba111';
export const OTHER_BAILIFF_USER_ID = '0192f1c4-0000-7000-8000-0000000ba112';
export const LAWYER_USER_ID = '0192f1c4-0000-7000-8000-0000000a7701';
export const VERIFICATION_FILE = '0192f1c4-0000-7000-8000-0000000fe001';
export const VERIFICATION_FILE_2 = '0192f1c4-0000-7000-8000-0000000fe011';
export const PROOF_FILE = '0192f1c4-0000-7000-8000-0000000fe002';
export const ACT_FILE = '0192f1c4-0000-7000-8000-0000000fe003';

export function litigationWorld() {
  const world = amicableWorld();
  const moneyWallet = new MoneyWallet(world.wallet);
  world.deps.wallet = moneyWallet;
  world.deps.paymentLinks = new MemoryPaymentLinks();
  world.directory.users.set(LEGAL_OFFICER_ID, 'Me Kossi Juriste');
  return {
    ...world,
    moneyWallet,
    litigation: world.deps.litigation as MemoryLitigationStore,
    money: world.deps.money as MemoryMoneyStore,
  };
}

export type LitigationWorld = ReturnType<typeof litigationWorld>;

/** Partenaire connecté (huissier ou avocat), sans double authentification. */
export function asPartner<T>(userId: string, fn: () => Promise<T>, role = 'recovery_bailiff'): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: 'gateway',
      user: {
        userId,
        sessionId: 's-test',
        activeContext: 'personal',
        roles: [{ role, scopeType: 'domain', scopeId: 'recovery' }],
        mfa: false,
      },
    },
    fn,
  );
}

export function partnerInput(change: Partial<PartnerInputData> = {}): PartnerInputData {
  return {
    kind: 'bailiff',
    name: 'Me Adjovi',
    office: 'Étude Adjovi, Cotonou',
    communeKeys: ['cotonou'],
    phones: ['+22997000555'],
    email: 'etude@adjovi.bj',
    userId: BAILIFF_USER_ID,
    fees: [{ actType: 'summons_to_pay', amount: 35_000 }],
    verificationFileId: VERIFICATION_FILE,
    ...change,
  };
}

/** Partenaire créé puis activé par le juriste. */
export async function activePartner(
  world: LitigationWorld,
  key = 'partner-0001',
  change: Partial<PartnerInputData> = {},
) {
  const created = await asLegal(world, () =>
    world.useCases.createPartner.execute({ idempotencyKey: key, input: partnerInput(change) }),
  );
  return asLegal(world, () =>
    world.useCases.updatePartner.execute({
      partnerId: created.partner.id,
      input: null,
      status: 'active',
      statusReason: '',
    }),
  );
}

/** Dossier actif passé en relance amiable puis en mise en demeure (superviseur). */
export async function caseAtFormalNotice(
  world: LitigationWorld,
  key = 'case-key-0001',
): Promise<RecoveryCaseRecord> {
  const record = await activeCase(world, key);
  for (const toStage of ['amicable', 'formal_notice']) {
    await asSupervisor(world, () =>
      world.useCases.changeCaseStage.execute({
        caseId: record.id,
        toStage,
        reason: 'Relances restées sans effet',
        skipReason: '',
      }),
    );
  }
  return caseOf(world, record.id);
}

/** Mise en demeure émise puis remise, son délai de 15 jours écoulé (horloge avancée). */
export async function expiredNotice(world: LitigationWorld, caseId: string) {
  const notice = await asLegal(world, () =>
    world.useCases.issueFormalNotice.execute({ caseId, idempotencyKey: 'notice-0001', deadlineDays: 0 }),
  );
  at(world, '2026-11-21T09:00:00.000Z');
  await asLegal(world, () =>
    world.useCases.recordNoticeDelivery.execute({
      caseId,
      noticeId: notice.notice.id,
      deliveryMethod: 'registered_mail',
      deliveredAt: '2026-11-21T08:00:00.000Z',
      proofFileId: PROOF_FILE,
    }),
  );
  at(world, '2026-12-07T09:00:00.000Z');
  return notice.notice;
}

/** Devis d'huissier soumis au créancier (2 lignes, 60 000 FCFA). */
export function requestBailiff(
  world: LitigationWorld,
  caseId: string,
  partnerId: string,
  key = 'quote-0001',
) {
  return asLegal(world, () =>
    world.useCases.requestEscalation.execute({
      caseId,
      idempotencyKey: key,
      stage: 'bailiff',
      partnerId,
      lines: [
        { label: 'Sommation de payer', amount: 35_000 },
        { label: 'Frais de déplacement', amount: 25_000 },
      ],
      validUntil: '2026-12-31T23:00:00.000Z',
      note: '',
    }),
  );
}

/** Réponse du créancier à une décision. */
export function answer(
  world: LitigationWorld,
  decisionId: string,
  reply: 'approve' | 'reject',
  key = 'answer-0001',
) {
  return asCreditor(() =>
    world.useCases.answerDecision.execute({
      decisionId,
      idempotencyKey: key,
      answer: reply,
      comment: '',
      fileIds: [],
    }),
  );
}

/**
 * Dossier à l'étape huissier : mise en demeure sans effet, devis accepté, provision de 60 000 FCFA
 * payée par le portefeuille, huissier actif assigné.
 */
export async function caseWithBailiff(world: LitigationWorld) {
  const record = await caseAtFormalNotice(world);
  const partner = await activePartner(world);
  await expiredNotice(world, record.id);
  const escalation = await requestBailiff(world, record.id, partner.partner.id);
  world.wallet.balances.set(CREDITOR_ID, (world.wallet.balances.get(CREDITOR_ID) ?? 0) + 100_000);
  await answer(world, escalation.decision.decision.id, 'approve');
  const assignment = await asLegal(world, () =>
    world.useCases.assignPartner.execute({ caseId: record.id, partnerId: partner.partner.id, note: '' }),
  );
  return { record: caseOf(world, record.id), partner, escalation, assignment };
}

export { asLegal, asSupervisor, at, caseOf, LEGAL_OFFICER_ID };
