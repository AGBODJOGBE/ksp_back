import {
  type ChannelProvider,
  type OutgoingMessage,
  type ProviderResult,
} from '../../application/send/notification.ports';
import { PhoneNumber } from '../../domain/recipient';

/**
 * Prestataire WhatsApp de développement : aucun appel à Meta, le message est écrit dans le terminal
 * pour qu'un développeur se connecte sans téléphone (ADR-021).
 *
 * C'est le SEUL endroit où un code de connexion peut apparaître dans une sortie du service, et
 * seulement en développement : la configuration refuse ce prestataire en production, et la fabrique
 * des prestataires le vérifie une seconde fois. L'écriture passe directement par la sortie standard,
 * hors du journal structuré.
 */
export class ConsoleWhatsAppProvider implements ChannelProvider {
  readonly channel = 'whatsapp' as const;

  constructor(private readonly write: (text: string) => void = (text) => process.stdout.write(text)) {}

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    const target = PhoneNumber.parse(message.phoneE164 ?? '')?.masked() ?? '?';
    // Message d'un événement : son texte ; code de connexion : ses variables.
    const body = message.content
      ? `\n${message.content.text}`
      : ` : ${Object.entries(message.variables)
          .map(([name, value]) => `${name}=${value}`)
          .join(', ')}`;
    this.write(
      `\n[notification · développement] WhatsApp vers ${target} — ${message.templateCode}${body}\n\n`,
    );
    return { accepted: true, providerMessageId: `console-${message.notificationId}` };
  }
}
