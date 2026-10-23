import { type ChannelProvider } from '../../application/send/notification.ports';
import { emailProviderKind, type ServiceConfig, whatsappProviderKind } from '../../config';
import { BrevoEmailProvider } from './brevo-email.provider';
import { ConsoleEmailProvider } from './console-email.provider';
import { ConsoleWhatsAppProvider } from './console-whatsapp.provider';
import { MetaWhatsAppProvider } from './meta-whatsapp.provider';

export interface ChannelProviderDeps {
  fetch?: typeof fetch;
  write?: (text: string) => void;
}

/**
 * Prestataires configurés, un par canal : WhatsApp (ADR-021) et e-mail (ADR-024). Le SMS et les
 * notifications push n'ont pas de prestataire, et ces canaux sont sautés.
 *
 * Garde-fou : refuse les prestataires `console` en production, même si la configuration a été
 * construite sans passer par son schéma.
 */
export function createChannelProviders(
  config: ServiceConfig,
  deps: ChannelProviderDeps = {},
): ChannelProvider[] {
  return [createWhatsAppProvider(config, deps), createEmailProvider(config, deps)];
}

function createEmailProvider(config: ServiceConfig, deps: ChannelProviderDeps): ChannelProvider {
  if (emailProviderKind(config) === 'console') {
    if (config.NODE_ENV === 'production') {
      throw new Error('Le prestataire e-mail « console » est interdit en production.');
    }
    return new ConsoleEmailProvider(deps.write);
  }
  if (!config.BREVO_API_KEY || !config.EMAIL_SENDER_ADDRESS) {
    throw new Error('BREVO_API_KEY et EMAIL_SENDER_ADDRESS sont obligatoires avec le prestataire brevo.');
  }
  return new BrevoEmailProvider({
    apiKey: config.BREVO_API_KEY,
    senderAddress: config.EMAIL_SENDER_ADDRESS,
    senderName: config.EMAIL_SENDER_NAME,
    timeoutMs: config.EMAIL_TIMEOUT_MS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

function createWhatsAppProvider(config: ServiceConfig, deps: ChannelProviderDeps): ChannelProvider {
  const kind = whatsappProviderKind(config);
  if (kind === 'console') {
    if (config.NODE_ENV === 'production') {
      throw new Error('Le prestataire WhatsApp « console » est interdit en production.');
    }
    return new ConsoleWhatsAppProvider(deps.write);
  }
  if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      'WHATSAPP_ACCESS_TOKEN et WHATSAPP_PHONE_NUMBER_ID sont obligatoires avec le prestataire meta.',
    );
  }
  return new MetaWhatsAppProvider({
    accessToken: config.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: config.WHATSAPP_API_VERSION,
    otpTemplate: config.WHATSAPP_OTP_TEMPLATE,
    language: config.WHATSAPP_TEMPLATE_LANGUAGE,
    timeoutMs: config.WHATSAPP_TIMEOUT_MS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
