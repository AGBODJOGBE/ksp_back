import { Logger } from '@nestjs/common';
import {
  type ChannelProvider,
  type OutgoingMessage,
  type ProviderResult,
} from '../../application/send/notification.ports';
import { type ProviderFailureReason } from '../../domain/delivery';
import { EmailAddress } from '../../domain/recipient';
import { toEmailHtml } from './email-html';

export interface BrevoEmailOptions {
  /** Clé d'API Brevo (coffre à secrets). Jamais journalisée. */
  apiKey: string;
  /** Adresse d'expédition, sur un domaine vérifié chez Brevo (SPF, DKIM). */
  senderAddress: string;
  senderName: string;
  timeoutMs: number;
  /** Remplaçable dans les tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface BrevoResponse {
  messageId?: unknown;
  code?: unknown;
}

/**
 * Adaptateur e-mail Brevo, API transactionnelle v3 (ADR-024) : `POST /v3/smtp/email`, clé
 * d'API dans l'en-tête `api-key`. Envoie l'objet, le texte brut et sa version HTML.
 *
 * Les journaux ne contiennent ni la clé, ni l'adresse du destinataire, ni le texte du message :
 * seulement le statut HTTP, le code d'erreur Brevo et le modèle KSP. Le texte d'erreur de Brevo
 * n'est pas repris, car il peut citer l'adresse.
 */
export class BrevoEmailProvider implements ChannelProvider {
  readonly channel = 'email' as const;
  private readonly logger = new Logger(BrevoEmailProvider.name);
  private readonly fetch: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: BrevoEmailOptions) {
    this.fetch = options.fetch ?? fetch;
    this.url = `${options.baseUrl ?? 'https://api.brevo.com'}/v3/smtp/email`;
  }

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    const to = EmailAddress.parse(message.email);
    if (!to) return { accepted: false, reason: 'recipient_invalid' };
    if (!message.content) {
      // Un modèle sans texte (code de connexion) ne part pas par e-mail.
      this.logger.error(`Aucun texte d'e-mail pour ${message.templateCode}.`);
      return { accepted: false, reason: 'provider_rejected' };
    }

    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: {
          'api-key': this.options.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: this.options.senderName, email: this.options.senderAddress },
          to: [{ email: to.value }],
          subject: message.content.subject,
          textContent: message.content.text,
          htmlContent: toEmailHtml(message.content),
          // Regroupe les statistiques par modèle dans la console Brevo.
          tags: [message.templateCode],
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // fetch interrompu par AbortSignal.timeout : DOMException nommée TimeoutError.
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      this.logger.warn(
        `Brevo injoignable (${timedOut ? `pas de réponse en ${this.options.timeoutMs} ms` : 'erreur réseau'}).`,
      );
      return { accepted: false, reason: 'provider_unavailable' };
    }

    const body = (await response.json().catch(() => null)) as BrevoResponse | null;
    if (response.ok) {
      const id = body?.messageId;
      if (typeof id === 'string' && id.length > 0) return { accepted: true, providerMessageId: id };
      this.logger.warn(`Réponse Brevo sans identifiant de message (HTTP ${response.status}).`);
      return { accepted: false, reason: 'provider_unavailable' };
    }

    const brevoCode = typeof body?.code === 'string' ? body.code : null;
    const reason = classify(response.status, brevoCode);
    this.logger.warn(
      `Envoi d'e-mail refusé par Brevo (${message.templateCode}) : HTTP ${response.status}, ` +
        `code ${brevoCode ?? 'inconnu'} → ${reason}.`,
    );
    return { accepted: false, reason };
  }
}

/**
 * Classement des refus de Brevo :
 * - panne, surcharge, limite d'envoi, quota du jour épuisé (402 de la formule gratuite) : indisponible ;
 * - paramètre invalide (400) : l'adresse a déjà été contrôlée, mais Brevo peut la refuser → destinataire ;
 * - clé invalide, expéditeur non vérifié, compte en validation… : problème de configuration chez KSP.
 */
function classify(status: number, brevoCode: string | null): ProviderFailureReason {
  if (status >= 500 || status === 429 || status === 402 || brevoCode === 'not_enough_credits') {
    return 'provider_unavailable';
  }
  if (status === 400 && brevoCode === 'invalid_parameter') return 'recipient_invalid';
  return 'provider_rejected';
}
