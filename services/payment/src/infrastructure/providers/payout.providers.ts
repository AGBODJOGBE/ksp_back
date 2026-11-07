import { Logger } from '@nestjs/common';
import { type PayoutProvider, type ProviderPayout } from '../../application/ports';
import { PaymentErrors } from '../../application/shared/errors';
import { type PayoutBeneficiary, type PayoutOperator, type ProviderPayoutStatus } from '../../domain/payout';

/** Mode manuel (ADR-039) : aucun appel, la finance fait le virement et le confirme au back-office. */
export const MANUAL_PAYOUTS: PayoutProvider = { name: 'manual', automatic: false };

/**
 * Mode Mobile Money FedaPay par opérateur (`mode` d'un reversement). **À valider avec le compte
 * FedaPay** (noms exacts des modes, Celtiis couvert ou non) : tant que ce n'est pas fait, garder
 * PAYOUT_PROVIDER=manual.
 */
export const FEDAPAY_PAYOUT_MODES: Record<PayoutOperator, string> = {
  mtn: 'mtn_open',
  moov: 'moov',
  celtiis: 'sbin',
};

/** Statuts FedaPay d'un reversement → statut du domaine ; toute autre valeur : `unknown`. */
const STATUSES: Record<string, ProviderPayoutStatus> = {
  pending: 'pending',
  scheduled: 'pending',
  started: 'processing',
  processing: 'processing',
  sent: 'sent',
  failed: 'failed',
};

export interface FedapayPayoutOptions {
  apiUrl: string;
  secretKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

/**
 * Reversements FedaPay, écrits d'après sa documentation publique (à valider avec le compte de test) :
 * création sans envoi (POST /payouts), lancement (PUT /payouts/start), relecture (GET /payouts/{id}),
 * notifications `payout.*` sur le même webhook que les transactions. Ni la clé, ni le numéro, ni les
 * réponses (qui les contiennent) ne sont journalisés : seulement l'opération et le statut HTTP.
 */
export class FedapayPayoutProvider {
  readonly name = 'fedapay' as const;
  readonly automatic = true as const;
  private readonly logger = new Logger('FedaPayPayouts');
  private readonly fetch: typeof fetch;

  constructor(private readonly options: FedapayPayoutOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async createPayout(request: {
    payoutId: string;
    amount: number;
    currency: 'XOF';
    beneficiary: PayoutBeneficiary;
  }): Promise<{ providerPayoutId: string; reference: string | null }> {
    const response = await this.call('POST', '/payouts', {
      amount: request.amount,
      currency: { iso: request.currency },
      mode: FEDAPAY_PAYOUT_MODES[request.beneficiary.operator],
      customer: {
        lastname: request.beneficiary.name,
        phone_number: { number: request.beneficiary.phone, country: 'bj' },
      },
      custom_metadata: { payout_id: request.payoutId },
    });
    const payout = this.payout(response);
    return { providerPayoutId: payout.providerPayoutId, reference: payout.reference };
  }

  async startPayout(providerPayoutId: string): Promise<void> {
    await this.call('PUT', '/payouts/start', {
      payouts: [{ id: Number(providerPayoutId) || providerPayoutId }],
    });
  }

  async getPayout(providerPayoutId: string): Promise<ProviderPayout> {
    return this.payout(await this.call('GET', `/payouts/${encodeURIComponent(providerPayoutId)}`));
  }

  /** Objet reversement des réponses FedaPay ({ "v1/payout": { … } } ou l'objet seul). */
  private payout(response: Json): ProviderPayout {
    const raw = (response['v1/payout'] ?? response['payout'] ?? response) as Json;
    const id = raw['id'];
    const amount = raw['amount'];
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof amount !== 'number') {
      this.logger.warn('Réponse inattendue de FedaPay (reversement)');
      throw PaymentErrors.providerUnavailable();
    }
    const iso = (raw['currency'] as Json | undefined)?.['iso'];
    return {
      providerPayoutId: String(id),
      status: STATUSES[typeof raw['status'] === 'string' ? raw['status'] : ''] ?? 'unknown',
      reference: typeof raw['reference'] === 'string' ? raw['reference'] : null,
      amount,
      // Jamais de XOF par défaut : une devise inconnue fait ignorer le statut (ADR-031).
      currency: typeof iso === 'string' && iso ? iso.toUpperCase() : 'UNKNOWN',
    };
  }

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<Json> {
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
      this.logger.warn(`${method} ${path.replace(/\/\d+$/, '/:id')} : ${(error as Error).name}`);
      throw PaymentErrors.providerUnavailable();
    }
    if (!response.ok) {
      this.logger.warn(`${method} ${path.replace(/\/\d+$/, '/:id')} : HTTP ${response.status}`);
      throw PaymentErrors.providerUnavailable();
    }
    try {
      return (await response.json()) as Json;
    } catch {
      this.logger.warn('Réponse inattendue de FedaPay (json)');
      throw PaymentErrors.providerUnavailable();
    }
  }
}
