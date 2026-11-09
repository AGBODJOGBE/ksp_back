import { type WalletEventPayloads } from '@ksp/contracts';
import { findTemplate, invalidVariables } from '../../domain/template';
import { type RuleContext } from './event-rules';
import { PAYMENT_RULES } from './payment.rules';
import { WALLET_RULES } from './wallet.rules';

const CONTEXT: RuleContext = {
  portalBaseUrl: 'https://ksp.bj',
  timeZone: 'Africa/Porto-Novo',
  cleaningTeamUserIds: [],
  accountsTeamUserIds: [],
};
const USER = '0192f1c4-0000-7000-8000-00000000c001';
const ORG = '0192f1c4-0000-7000-8000-00000000a001';
const ID = '0192f1c4-0000-7000-8000-00000000e001';
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

const debited: WalletEventPayloads['wallet.prepaid.debited'] = {
  transactionId: ID,
  holder: { type: 'user', id: USER },
  userId: USER,
  amount: xof(15000),
  balanceAfter: xof(5000),
  service: 'cleaning',
  objectType: 'cleaning_mission',
  objectId: ID,
  part: 'deposit',
  description: 'Nettoyage de maison — acompte',
  debitedAt: '2026-11-09T10:00:00Z',
};

const credited: WalletEventPayloads['wallet.prepaid.credited'] = {
  transactionId: ID,
  kind: 'refund',
  origin: 'service',
  holder: { type: 'user', id: USER },
  userId: USER,
  amount: xof(15000),
  balanceAfter: xof(20000),
  description: 'Remboursement — Nettoyage de maison — acompte (mission annulée)',
  paymentId: null,
  refundedTransactionId: ID,
  creditedAt: '2026-11-09T11:00:00Z',
};

describe('messages du portefeuille prépayé (ADR-046)', () => {
  it('paiement depuis le portefeuille : montant, objet, solde restant, lien vers le portefeuille', () => {
    const [intent] = WALLET_RULES['wallet.prepaid.debited']!(debited, CONTEXT);
    expect(intent).toMatchObject({
      userId: USER,
      templateCode: 'wallet.payment.customer',
      link: 'https://ksp.bj/mon-espace/portefeuille',
      variables: { object: 'Nettoyage de maison — acompte' },
    });
    const template = findTemplate('wallet.payment.customer')!;
    expect(invalidVariables(template, { ...intent!.variables, first_name: 'Koffi' })).toEqual([]);
    expect(template.render!({ ...intent!.variables, first_name: 'Koffi' }).text).toContain(
      'depuis votre portefeuille KSP pour : Nettoyage de maison — acompte.',
    );
  });

  it('remboursement : « portefeuille crédité » ; recharge confirmée : rien (reçu de paiement)', () => {
    const [intent] = WALLET_RULES['wallet.prepaid.credited']!(credited, CONTEXT);
    expect(intent).toMatchObject({ templateCode: 'wallet.credit.customer', userId: USER });
    const template = findTemplate('wallet.credit.customer')!;
    expect(invalidVariables(template, { ...intent!.variables, first_name: '' })).toEqual([]);
    expect(
      WALLET_RULES['wallet.prepaid.credited']!({ ...credited, kind: 'top_up', origin: 'payment' }, CONTEXT),
    ).toEqual([]);
  });

  it('organisation : e-mail de facturation ; crédit de la finance sans destinataire : aucun message', () => {
    const org = { ...debited, holder: { type: 'organization' as const, id: ORG } };
    expect(WALLET_RULES['wallet.prepaid.debited']!(org, CONTEXT)[0]).toMatchObject({
      billingOrganizationId: ORG,
    });
    expect(
      WALLET_RULES['wallet.prepaid.credited']!(
        { ...credited, origin: 'finance', holder: { type: 'organization', id: ORG }, userId: null },
        CONTEXT,
      ),
    ).toEqual([]);
  });

  it('recharge réussie : reçu du paiement, lien vers le portefeuille', () => {
    const [intent] = PAYMENT_RULES['payment.intent.succeeded']!(
      {
        paymentId: ID,
        subjectType: 'wallet_top_up',
        subjectId: USER,
        part: null,
        subjectReference: null,
        customerId: USER,
        organizationId: null,
        amount: xof(20000),
        provider: 'fedapay',
        method: 'mobile_money_online',
        providerReference: 'trx_1',
        succeededAt: '2026-11-09T09:00:00Z',
      },
      CONTEXT,
    );
    expect(intent).toMatchObject({
      templateCode: 'payment.receipt.customer',
      link: 'https://ksp.bj/mon-espace/portefeuille',
      variables: { object: 'la recharge de votre portefeuille KSP' },
    });
  });
});
