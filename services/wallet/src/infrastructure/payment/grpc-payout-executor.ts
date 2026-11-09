import { type paymentV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type PayoutExecutor } from '../../application/ports';

/**
 * Reversements transmis à payment (PayoutService.RequestPayout, ADR-041) avec le jeton de service de
 * wallet (ADR-022). L'appel est idempotent chez payment (clé = identifiant du reversement wallet) :
 * il peut être rejoué sans risque de second envoi. Délai long : payment peut appeler le prestataire.
 */
export class GrpcPayoutExecutor implements PayoutExecutor {
  constructor(
    private readonly client: paymentV1.PayoutServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async request(input: Parameters<PayoutExecutor['request']>[0]): Promise<{ payoutId: string }> {
    const res = await this.caller.call(
      'requestPayout',
      (metadata) =>
        this.client.requestPayout(
          {
            idempotencyKey: input.idempotencyKey,
            reference: input.reference,
            amount: { amount: input.amount, currency: 'XOF' },
            beneficiary: input.beneficiary,
          },
          metadata,
        ),
      { idempotent: true, deadlineMs: 15_000 },
    );
    if (!res.payout?.id) throw new Error('Réponse de payment sans reversement.');
    return { payoutId: res.payout.id };
  }
}
