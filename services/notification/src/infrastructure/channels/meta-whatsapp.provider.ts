import { Logger } from '@nestjs/common';
import {
  type ChannelProvider,
  type OutgoingMessage,
  type ProviderResult,
} from '../../application/send/notification.ports';
import { type ProviderFailureReason } from '../../domain/delivery';
import { WHATSAPP_EVENT_TEMPLATES } from './whatsapp-templates';

export interface MetaWhatsAppOptions {
  /** Jeton de l'utilisateur système Meta. Jamais journalisé. */
  accessToken: string;
  phoneNumberId: string;
  /** Version de l'API Graph, par exemple v23.0. */
  apiVersion: string;
  /** Nom du modèle d'authentification approuvé (ksp_otp). */
  otpTemplate: string;
  /** Langue du modèle approuvé (fr). */
  language: string;
  timeoutMs: number;
  /** Remplaçable dans les tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Erreurs Graph propres au destinataire : numéro sans WhatsApp, ou numéro de l'expéditeur lui-même. */
const RECIPIENT_ERRORS = new Set([131021, 131026]);

/** Erreurs Graph passagères (panne, surcharge, limites d'envoi) : on peut réessayer plus tard. */
const TRANSIENT_ERRORS = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

interface GraphResponse {
  messages?: { id?: unknown }[];
  error?: { code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
}

/**
 * Adaptateur WhatsApp Cloud API de Meta (ADR-021) : envoie le modèle d'authentification
 * « Copier le code » (le code figure deux fois, corps et bouton, comme l'exige Meta), ou le modèle
 * approuvé d'un message déclenché par un événement.
 *
 * Les journaux ne contiennent ni le jeton, ni le numéro, ni le code : seulement le statut HTTP,
 * le code d'erreur Graph et l'identifiant de trace de Meta.
 */
export class MetaWhatsAppProvider implements ChannelProvider {
  readonly channel = 'whatsapp' as const;
  private readonly logger = new Logger(MetaWhatsAppProvider.name);
  private readonly fetch: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: MetaWhatsAppOptions) {
    this.fetch = options.fetch ?? fetch;
    this.url = `${options.baseUrl ?? 'https://graph.facebook.com'}/${options.apiVersion}/${encodeURIComponent(options.phoneNumberId)}/messages`;
  }

  async send(message: OutgoingMessage): Promise<ProviderResult> {
    if (!message.phoneE164) return { accepted: false, reason: 'recipient_invalid' };
    const template = this.templateFor(message);
    if (!template) {
      this.logger.error(`Aucun modèle WhatsApp pour ${message.templateCode}.`);
      return { accepted: false, reason: 'provider_rejected' };
    }

    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.phoneE164,
          type: 'template',
          template,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // fetch interrompu par AbortSignal.timeout : DOMException nommée TimeoutError.
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      this.logger.warn(
        `WhatsApp injoignable (${timedOut ? `pas de réponse en ${this.options.timeoutMs} ms` : 'erreur réseau'}).`,
      );
      return { accepted: false, reason: 'provider_unavailable' };
    }

    const body = (await response.json().catch(() => null)) as GraphResponse | null;
    if (response.ok) {
      const id = body?.messages?.[0]?.id;
      if (typeof id === 'string' && id.length > 0) return { accepted: true, providerMessageId: id };
      this.logger.warn(`Réponse WhatsApp sans identifiant de message (HTTP ${response.status}).`);
      return { accepted: false, reason: 'provider_unavailable' };
    }

    const graphCode = typeof body?.error?.code === 'number' ? body.error.code : null;
    const reason = classify(response.status, graphCode);
    this.logger.warn(
      `Envoi WhatsApp refusé : HTTP ${response.status}, erreur Graph ${graphCode ?? 'inconnue'}` +
        `${typeof body?.error?.error_subcode === 'number' ? `/${body.error.error_subcode}` : ''}` +
        `${typeof body?.error?.fbtrace_id === 'string' ? `, trace ${body.error.fbtrace_id}` : ''} → ${reason}.`,
    );
    return { accepted: false, reason };
  }

  /**
   * Modèle WhatsApp correspondant au modèle KSP : identity.otp → modèle d'authentification ;
   * messages des événements → modèle « utility » approuvé (whatsapp-templates.ts).
   */
  private templateFor(message: OutgoingMessage): object | null {
    if (message.templateCode !== 'identity.otp') {
      const spec = Object.hasOwn(WHATSAPP_EVENT_TEMPLATES, message.templateCode)
        ? WHATSAPP_EVENT_TEMPLATES[message.templateCode]
        : null;
      if (!spec) return null;
      return {
        name: spec.name(message.variables),
        language: { code: this.options.language },
        components: [
          {
            type: 'body',
            parameters: spec.parameters(message.variables).map((text) => ({ type: 'text', text })),
          },
        ],
      };
    }
    const code = message.variables['code'] ?? '';
    return {
      name: this.options.otpTemplate,
      // Seule la langue approuvée chez Meta est utilisée au lot 1 (voir README).
      language: { code: this.options.language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    };
  }
}

function classify(status: number, graphCode: number | null): ProviderFailureReason {
  if (graphCode !== null && RECIPIENT_ERRORS.has(graphCode)) return 'recipient_invalid';
  if (status >= 500 || status === 429 || (graphCode !== null && TRANSIENT_ERRORS.has(graphCode))) {
    return 'provider_unavailable';
  }
  // Jeton expiré, modèle absent ou non approuvé, compte bloqué… : problème de configuration chez KSP.
  return 'provider_rejected';
}
