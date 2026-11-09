import { type WalletEventPayloads, type WalletEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';

/**
 * Messages du portefeuille prépayé (ADR-046) :
 * - `wallet.prepaid.debited` : « paiement effectué depuis votre portefeuille » ;
 * - `wallet.prepaid.credited` : « portefeuille crédité » pour un remboursement ou un crédit de la
 *   finance. Une recharge confirmée par le prestataire (origine `payment`) n'envoie rien ici : le
 *   reçu du paiement Mobile Money (`payment.receipt.customer`) en tient lieu.
 *
 * Destinataire : `userId` de l'événement (le titulaire, sinon le membre qui a payé) ; aucun message
 * s'il est absent (crédit de la finance à une organisation). Portefeuille d'une organisation :
 * l'e-mail part à son e-mail de facturation vérifié, comme les factures (ADR-028).
 *
 * Lien : le portefeuille dans Mon espace KSP, /mon-espace/portefeuille.
 */

function intent(
  event: { userId: string | null; holder: { type: string; id: string } },
  templateCode: string,
  context: RuleContext,
  variables: Record<string, string>,
): NotificationIntent[] {
  if (!event.userId) return [];
  const link = `${context.portalBaseUrl}/mon-espace/portefeuille`;
  return [
    {
      userId: event.userId,
      templateCode,
      variables: { ...variables, organization_name: '', link },
      link,
      ...(event.holder.type === 'organization' ? { billingOrganizationId: event.holder.id } : {}),
    },
  ];
}

export const WALLET_RULES: { readonly [T in WalletEventType]?: EventRule<T> } = {
  'wallet.prepaid.debited': (event: WalletEventPayloads['wallet.prepaid.debited'], context) =>
    intent(event, 'wallet.payment.customer', context, {
      amount: formatXof(event.amount.amount),
      object: event.description,
      balance: formatXof(event.balanceAfter.amount),
    }),
  'wallet.prepaid.credited': (event: WalletEventPayloads['wallet.prepaid.credited'], context) =>
    event.origin === 'payment'
      ? []
      : intent(event, 'wallet.credit.customer', context, {
          amount: formatXof(event.amount.amount),
          object: event.description,
          balance: formatXof(event.balanceAfter.amount),
        }),
};
