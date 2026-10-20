import { type ChannelProvider } from '../../application/send/notification.ports';
import { type ServiceConfig, whatsappProviderKind } from '../../config';
import { ConsoleWhatsAppProvider } from './console-whatsapp.provider';
import { MetaWhatsAppProvider } from './meta-whatsapp.provider';

export interface ChannelProviderDeps {
  fetch?: typeof fetch;
  write?: (text: string) => void;
}

/**
 * Prestataires configurés, un par canal. Au lancement : WhatsApp seul (ADR-021) ; le SMS, l'e-mail
 * et les notifications push n'ont pas de prestataire, et ces canaux sont sautés.
 *
 * Garde-fou : refuse le prestataire `console` en production, même si la configuration a été
 * construite sans passer par son schéma.
 */
export function createChannelProviders(
  config: ServiceConfig,
  deps: ChannelProviderDeps = {},
): ChannelProvider[] {
  const kind = whatsappProviderKind(config);
  if (kind === 'console') {
    if (config.NODE_ENV === 'production') {
      throw new Error('Le prestataire WhatsApp « console » est interdit en production.');
    }
    return [new ConsoleWhatsAppProvider(deps.write)];
  }
  if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      'WHATSAPP_ACCESS_TOKEN et WHATSAPP_PHONE_NUMBER_ID sont obligatoires avec le prestataire meta.',
    );
  }
  return [
    new MetaWhatsAppProvider({
      accessToken: config.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: config.WHATSAPP_API_VERSION,
      otpTemplate: config.WHATSAPP_OTP_TEMPLATE,
      language: config.WHATSAPP_TEMPLATE_LANGUAGE,
      timeoutMs: config.WHATSAPP_TIMEOUT_MS,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
  ];
}
