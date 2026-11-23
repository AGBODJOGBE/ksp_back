import { notificationV1, type walletV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { callDependency } from './dependency';
import { DEBTOR_TEMPLATES, GrpcNotifier, notificationKey } from './grpc-notifier';
import { GrpcWalletGateway } from './grpc-wallet.gateway';

/** GrpcCaller factice : exécute l'appel avec des métadonnées vides, ou échoue comme demandé. */
function fakeCaller(failure?: AppError): GrpcCaller {
  return {
    call: async (_name: string, invoke: (metadata: never) => unknown) => {
      if (failure) throw failure;
      const result = invoke({} as never);
      return isObservable(result) ? firstValueFrom(result) : result;
    },
  } as unknown as GrpcCaller;
}

describe('adaptateurs gRPC de recovery', () => {
  describe('callDependency', () => {
    it.each([
      ['UNAVAILABLE', AppError.unavailable('WALLET_UNAVAILABLE', 'coupé')],
      ['DEADLINE_EXCEEDED', new AppError('DEADLINE_EXCEEDED', 'GRPC_DEADLINE_EXCEEDED', 'lent')],
    ])('une panne (%s) devient RECOVERY_DEPENDENCY_UNAVAILABLE', async (_kind, failure) => {
      await expect(
        callDependency('wallet', fakeCaller(failure), 'debit', () => of({})),
      ).rejects.toMatchObject({
        code: 'RECOVERY_DEPENDENCY_UNAVAILABLE',
        details: { service: 'wallet' },
      });
    });

    it('un refus métier du service appelé est transmis tel quel', async () => {
      const refusal = AppError.precondition('WALLET_INSUFFICIENT_FUNDS', 'Solde insuffisant');
      await expect(callDependency('wallet', fakeCaller(refusal), 'debit', () => of({}))).rejects.toBe(
        refusal,
      );
    });
  });

  describe('notification : messages directs au débiteur', () => {
    const sent: notificationV1.SendNotificationRequest[] = [];
    const client = {
      sendNotification: (request: notificationV1.SendNotificationRequest) => {
        sent.push(request);
        return of({ notificationId: 'n-1', channelUsed: request.channel, status: 'DELIVERY_STATUS_QUEUED' });
      },
    } as unknown as notificationV1.NotificationServiceClient;
    const notifier = new GrpcNotifier(client, fakeCaller());

    beforeEach(() => sent.splice(0));

    it('préfixe toujours la clé par « recovery: » et n’envoie que des modèles recovery.*', async () => {
      await notifier.sendToDebtor({
        message: 'payment_link',
        channel: 'whatsapp',
        phone: '+2290197000101',
        email: null,
        variables: { link: 'https://ksp.bj/recouvrement/x' },
        idempotencyKey: 'RC-000123:payment_link:1',
      });
      expect(sent[0]).toMatchObject({
        templateCode: 'recovery.debtor_payment_link',
        channel: notificationV1.Channel.CHANNEL_WHATSAPP,
        fallbackChannels: [],
        recipient: { userId: '', phoneE164: '+2290197000101', email: '' },
        idempotencyKey: 'recovery:RC-000123:payment_link:1',
      });
      expect(notificationKey('recovery:deja')).toBe('recovery:deja');
      expect(Object.values(DEBTOR_TEMPLATES).every((code) => code.startsWith('recovery.debtor_'))).toBe(true);
    });

    it('le canal est un paramètre ; l’autre canal sert de repli si sa coordonnée est connue', async () => {
      await notifier.sendToDebtor({
        message: 'access_code',
        channel: 'email',
        phone: '+2290197000101',
        email: 'debiteur@example.com',
        variables: { code: '123456' },
        idempotencyKey: 'RC-000123:code:1',
      });
      expect(sent[0]).toMatchObject({
        templateCode: 'recovery.debtor_access_code',
        channel: notificationV1.Channel.CHANNEL_EMAIL,
        fallbackChannels: [notificationV1.Channel.CHANNEL_WHATSAPP],
      });
    });

    it('refuse un canal sans coordonnée', async () => {
      await expect(
        notifier.sendToDebtor({
          message: 'reminder',
          channel: 'email',
          phone: '+2290197000101',
          email: null,
          variables: {},
          idempotencyKey: 'RC-000123:reminder:1',
        }),
      ).rejects.toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'channel' } });
      expect(sent).toHaveLength(0);
    });
  });

  describe('wallet : encaissement avec la commission calculée par recovery', () => {
    it('transmet commission_amount et le taux effectif', async () => {
      const requests: walletV1.RecordCollectionRequest[] = [];
      const client = {
        recordCollection: (request: walletV1.RecordCollectionRequest) => {
          requests.push(request);
          return of({ transaction: { id: 't-1' }, created: true });
        },
      } as unknown as walletV1.WalletServiceClient;
      const gateway = new GrpcWalletGateway(client, fakeCaller());
      const result = await gateway.recordCollection({
        holder: { type: 'organization', id: 'o-1' },
        gross: 40_000,
        commission: 4_000,
        commissionRateBps: 1_000,
        reference: 'payment:p-1',
        description: 'Encaissement RC-000123',
      });
      expect(result).toEqual({ transactionId: 't-1', created: true });
      expect(requests[0]).toMatchObject({
        grossAmount: { amount: 40_000, currency: 'XOF' },
        commissionAmount: { amount: 4_000, currency: 'XOF' },
        commissionRateBps: 1_000,
        reference: 'payment:p-1',
      });
    });
  });
});
