import {
  type ChannelProvider,
  type OutgoingMessage,
  type ProviderResult,
} from '../../application/send/notification.ports';
import { EmailAddress } from '../../domain/recipient';

/**
 * Prestataire e-mail de développement : aucun appel à Brevo, l'e-mail (objet et texte) est écrit
 * dans le terminal avec l'adresse masquée. Refusé en production par la configuration et, une
 * seconde fois, par la fabrique des prestataires (même garde-fou que WhatsApp, ADR-021).
 */
export class ConsoleEmailProvider implements ChannelProvider {
  readonly channel = 'email' as const;

  constructor(private readonly write: (text: string) => void = (text) => process.stdout.write(text)) {}

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    const to = EmailAddress.parse(message.email);
    if (!to) return { accepted: false, reason: 'recipient_invalid' };
    if (!message.content) return { accepted: false, reason: 'provider_rejected' };
    this.write(
      `\n[notification · développement] E-mail vers ${to.masked()} — ${message.templateCode}\n` +
        `Objet : ${message.content.subject}\n${message.content.text}\n\n`,
    );
    return { accepted: true, providerMessageId: `console-email-${message.notificationId}` };
  }
}
