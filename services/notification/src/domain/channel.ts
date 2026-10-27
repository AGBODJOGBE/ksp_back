/** Canaux de notification (noms de l'événement notification.message.failed). */
export type ChannelName = 'sms' | 'whatsapp' | 'email' | 'push' | 'in_app';

/** Canal utilisé quand l'appelant n'en précise pas : WhatsApp, seul canal au lancement (ADR-021). */
export const DEFAULT_CHANNEL: ChannelName = 'whatsapp';

/** Canaux qui s'adressent à un numéro de téléphone. */
export function isPhoneChannel(channel: ChannelName): boolean {
  return channel === 'sms' || channel === 'whatsapp';
}

/**
 * Canaux à essayer, dans l'ordre : le canal demandé (WhatsApp s'il n'est pas précisé), puis les
 * canaux de bascule. Un canal n'apparaît qu'une fois ; ceux que le modèle ne prévoit pas sont retirés.
 */
export function channelPlan(
  requested: ChannelName | null,
  fallbacks: readonly ChannelName[],
  supported: readonly ChannelName[],
): ChannelName[] {
  const plan: ChannelName[] = [];
  for (const channel of [requested ?? DEFAULT_CHANNEL, ...fallbacks]) {
    if (supported.includes(channel) && !plan.includes(channel)) plan.push(channel);
  }
  return plan;
}

/**
 * Canaux d'un message déclenché par un événement (règle du lot 2), selon sa nature et les
 * coordonnées connues du destinataire. Un seul message part par destinataire : le second canal
 * ne sert qu'en bascule si le premier échoue.
 * - message court (`short`) : WhatsApp, puis e-mail ;
 * - document (`document` : devis, compte rendu) : e-mail, puis WhatsApp.
 * Un canal sans coordonnée est retiré. La notification dans l'espace KSP est enregistrée à part,
 * dans tous les cas.
 */
export function eventChannelPlan(
  kind: 'short' | 'document',
  contact: { hasPhone: boolean; hasEmail: boolean },
): ChannelName[] {
  const order: ChannelName[] = kind === 'document' ? ['email', 'whatsapp'] : ['whatsapp', 'email'];
  return order.filter((channel) => (channel === 'email' ? contact.hasEmail : contact.hasPhone));
}

/**
 * Envois d'un message d'événement : un plan de canaux par envoi.
 * - `short` et `document` : un seul envoi, avec bascule (`eventChannelPlan`) ;
 * - `important` (avertissement, suspension) : un envoi par WhatsApp ET un par e-mail, chacun sans
 *   bascule, pour que le message soit vu.
 * Aucun envoi si le destinataire n'a ni téléphone ni e-mail.
 */
export function eventDispatchPlans(
  kind: 'short' | 'document' | 'important',
  contact: { hasPhone: boolean; hasEmail: boolean },
): ChannelName[][] {
  if (kind !== 'important') {
    const plan = eventChannelPlan(kind, contact);
    return plan.length > 0 ? [plan] : [];
  }
  return eventChannelPlan('short', contact).map((channel) => [channel]);
}
