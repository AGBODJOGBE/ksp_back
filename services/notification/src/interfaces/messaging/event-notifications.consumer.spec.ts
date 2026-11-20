import { type EventEnvelope } from '@ksp/contracts';
import { type RabbitMqConsumer } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type NotifyEventUseCase } from '../../application/events/notify-event.use-case';
import { EventNotificationsConsumer } from './event-notifications.consumer';

const envelope = {
  eventId: '0192f1c4-aaaa-7000-8000-000000000001',
  type: 'cleaning.quote.sent',
  version: 1,
  occurredAt: '2026-10-23T10:00:00.000Z',
  producer: 'cleaning',
  correlationId: 'c-1',
  causationId: null,
  payload: {},
} as unknown as EventEnvelope;

describe('EventNotificationsConsumer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('s’abonne aux 45 événements du Nettoyage v2, aux 3 de la facturation, aux 5 des comptes entreprise, aux 2 de la suppression du compte, à la réinitialisation de la double authentification, au paiement en ligne et aux 2 du portefeuille (files notification.<événement>)', async () => {
    const subscribed: [string, readonly number[] | undefined][] = [];
    const consumer = {
      subscribe: async (type: string, _handler: unknown, options: { versions?: readonly number[] }) =>
        void subscribed.push([type, options.versions]),
    } as unknown as RabbitMqConsumer;
    await new EventNotificationsConsumer(consumer, {} as NotifyEventUseCase).onApplicationBootstrap();
    const types = subscribed.map(([type]) => type).sort();
    // Nettoyage : liste détaillée dans cleaning.rules.spec.ts (tableau 16.2).
    expect(types.filter((type) => type.startsWith('cleaning.'))).toHaveLength(45);
    expect(types.filter((type) => !type.startsWith('cleaning.'))).toEqual([
      'billing.invoice.issued',
      'billing.invoice.overdue',
      'billing.invoice.paid',
      'identity.organization.created',
      'identity.organization.reactivated',
      'identity.organization.rejected',
      'identity.organization.suspended',
      'identity.organization.validated',
      'identity.user.deletion_cancelled',
      'identity.user.deletion_requested',
      'identity.user.mfa_reset',
      'payment.intent.succeeded',
      'wallet.prepaid.credited',
      'wallet.prepaid.debited',
    ]);
    // Portefeuille crédité lu en versions 1 et 2 (RV-101) ; version 1 seule pour les autres.
    const versions = new Map(subscribed);
    expect(versions.get('wallet.prepaid.credited')).toEqual([1, 2]);
    expect(versions.get('wallet.prepaid.debited')).toBeUndefined();
  });

  it('délègue au cas d’usage et journalise les compteurs, sans données personnelles', async () => {
    const logs: string[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
    const useCase = {
      execute: async () => ({
        status: 'processed',
        accepted: 1,
        failed: 0,
        replayed: 0,
        recipientsNotFound: 0,
        unreachable: 0,
        inApp: 1,
      }),
    } as unknown as NotifyEventUseCase;
    await new EventNotificationsConsumer({} as RabbitMqConsumer, useCase).handle(envelope);
    expect(logs[0]).toContain('cleaning.quote.sent (0192f1c4-aaaa-7000-8000-000000000001)');
    expect(logs[0]).toContain('1 message(s) pris en charge');
  });

  it('propage l’erreur du cas d’usage : le kit renvoie l’événement en file de reprise', async () => {
    const useCase = {
      execute: async () => {
        throw new Error('identity indisponible');
      },
    } as unknown as NotifyEventUseCase;
    await expect(
      new EventNotificationsConsumer({} as RabbitMqConsumer, useCase).handle(envelope),
    ).rejects.toThrow('identity indisponible');
  });
});
