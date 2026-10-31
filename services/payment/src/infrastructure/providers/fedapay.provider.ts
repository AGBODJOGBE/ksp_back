import { type AppError } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import {
  type Checkout,
  type CheckoutRequest,
  type PaymentProvider,
  type ProviderNotification,
  type ProviderTransaction,
} from '../../application/ports';
import { PaymentErrors } from '../../application/shared/errors';
import { type ProviderStatus } from '../../domain/payment-intent';
import { verifySignature } from './webhook-signature';

export const FEDAPAY_API_URLS = {
  sandbox: 'https://sandbox-api.fedapay.com/v1',
  live: 'https://api.fedapay.com/v1',
} as const;

export interface FedapayOptions {
  /** Adresse de l'API (sandbox ou live), sans barre finale. */
  apiUrl: string;
  /** Clé secrète (sk_sandbox_… ou sk_live_…), fournie par le coffre ; jamais journalisée. */
  secretKey: string;
  /** Secret de signature du webhook, fourni par le coffre ; jamais journalisé. */
  webhookSecret: string;
  /**
   * Identifiant FedaPay de la devise XOF (`currency_id` des transactions), à relever dans le compte
   * de test (ADR-031). Absent : seule la devise ISO de la réponse établit le XOF.
   */
  xofCurrencyId?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

/**
 * Statuts de transaction FedaPay → statut du domaine. `transferred` : fonds reversés au marchand
 * après approbation, donc réglé. Toute autre valeur : `unknown` (aucun changement).
 */
const STATUSES: Record<string, ProviderStatus> = {
  pending: 'pending',
  approved: 'approved',
  transferred: 'approved',
  declined: 'declined',
  canceled: 'canceled',
  cancelled: 'canceled',
  expired: 'expired',
  refunded: 'refunded',
};

/**
 * Adaptateur FedaPay, écrit d'après sa documentation publique (ADR-031) : création de la
 * transaction (POST /transactions), jeton et page de paiement (POST /transactions/{id}/token),
 * relecture (GET /transactions/{id}), notifications signées. Aucune donnée du payeur n'est envoyée :
 * la page de FedaPay demande elle-même le numéro Mobile Money. Pas d'annulation de transaction :
 * l'API publique n'en documente pas pour le marchand (à confirmer avec le compte de test) ; une
 * réussite tardive est rattrapée par le rapprochement (ADR-031). Ni la clé ni les réponses ne sont
 * journalisées (les réponses contiennent les coordonnées du payeur) : seulement l'opération et
 * le statut HTTP.
 */
export class FedapayProvider implements PaymentProvider {
  readonly name = 'fedapay' as const;
  private readonly logger = new Logger('FedaPay');
  private readonly fetch: typeof fetch;

  constructor(private readonly options: FedapayOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async createCheckout(request: CheckoutRequest): Promise<Checkout> {
    const created = await this.call('POST', '/transactions', {
      description: request.description,
      amount: request.amount,
      currency: { iso: request.currency },
      callback_url: request.returnUrl,
      custom_metadata: { payment_id: request.paymentId },
    });
    const transaction = this.transaction(created);
    const token = await this.call('POST', `/transactions/${encodeURIComponent(transaction.id)}/token`, {});
    const url = typeof token['url'] === 'string' ? token['url'] : null;
    if (!url) throw this.unexpected('token');
    return { transactionId: transaction.id, reference: transaction.reference, checkoutUrl: url };
  }

  async getTransaction(transactionId: string): Promise<ProviderTransaction> {
    const response = await this.call('GET', `/transactions/${encodeURIComponent(transactionId)}`);
    const transaction = this.transaction(response);
    return {
      transactionId: transaction.id,
      paymentId: transaction.paymentId,
      reference: transaction.reference,
      status: STATUSES[transaction.status] ?? 'unknown',
      amount: transaction.amount,
      currency: transaction.currency,
    };
  }

  verifyNotification(payload: Uint8Array, signature: string, now: Date): ProviderNotification {
    if (!verifySignature(payload, signature, this.options.webhookSecret, now)) {
      throw PaymentErrors.signatureInvalid();
    }
    let event: Json;
    try {
      event = JSON.parse(Buffer.from(payload).toString('utf8')) as Json;
    } catch {
      throw PaymentErrors.invalid('payload', 'Notification illisible.');
    }
    const entity = (event['entity'] ?? {}) as Json;
    const id = (value: unknown) =>
      typeof value === 'number' || (typeof value === 'string' && value) ? String(value) : null;
    return {
      eventName: typeof event['name'] === 'string' ? event['name'] : 'unknown',
      eventId: id(event['id']),
      transactionId: id(entity['id']),
    };
  }

  /** Objet transaction des réponses FedaPay ({ "v1/transaction": { … } } ou l'objet seul). */
  private transaction(response: Json) {
    const raw = (response['v1/transaction'] ?? response['transaction'] ?? response) as Json;
    const id = raw['id'];
    const amount = raw['amount'];
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof amount !== 'number') {
      throw this.unexpected('transaction');
    }
    const metadata = (raw['custom_metadata'] ?? {}) as Json;
    return {
      paymentId: typeof metadata['payment_id'] === 'string' ? metadata['payment_id'] : null,
      id: String(id),
      reference: typeof raw['reference'] === 'string' ? raw['reference'] : null,
      status: typeof raw['status'] === 'string' ? raw['status'] : 'unknown',
      amount,
      currency: this.currency(raw),
    };
  }

  /**
   * Devise de la transaction, établie par `currency.iso` et `currency_id` (comparé à l'identifiant
   * XOF configuré). Jamais de XOF par défaut : une devise qui ne peut pas être établie vaut
   * `UNKNOWN`, et le paiement approuvé passe en `amount_mismatch` (ADR-031).
   */
  private currency(raw: Json): string {
    const iso = (raw['currency'] as Json | undefined)?.['iso'];
    const id = raw['currency_id'];
    const knownId = this.options.xofCurrencyId;
    const idIsXof =
      knownId !== undefined && (typeof id === 'number' || typeof id === 'string')
        ? String(id) === knownId
        : null;
    if (typeof iso === 'string' && iso) {
      // Les deux indications doivent concorder quand elles existent.
      if (iso.toUpperCase() === 'XOF' && idIsXof === false) return 'UNKNOWN';
      return iso.toUpperCase();
    }
    return idIsXof ? 'XOF' : 'UNKNOWN';
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetch(`${this.options.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      this.logger.warn(`${method} ${operation(path)} : ${(error as Error).name}`);
      throw PaymentErrors.providerUnavailable();
    }
    if (!response.ok) {
      this.logger.warn(`${method} ${operation(path)} : HTTP ${response.status}`);
      throw PaymentErrors.providerUnavailable();
    }
    try {
      return (await response.json()) as Json;
    } catch {
      throw this.unexpected('json');
    }
  }

  private unexpected(what: string): AppError {
    this.logger.warn(`Réponse inattendue de FedaPay (${what})`);
    return PaymentErrors.providerUnavailable();
  }
}

/** Opération sans identifiant, pour les journaux. */
function operation(path: string): string {
  return path.replace(/\/[^/]*\d[^/]*/g, '/:id');
}
