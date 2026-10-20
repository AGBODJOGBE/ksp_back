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
