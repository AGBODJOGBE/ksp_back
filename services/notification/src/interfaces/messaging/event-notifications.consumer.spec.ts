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

  it('s’abonne aux 7 événements du Nettoyage (files notification.<événement>)', async () => {
    const subscribed: string[] = [];
    const consumer = {
      subscribe: async (type: string) => void subscribed.push(type),
    } as unknown as RabbitMqConsumer;
    await new EventNotificationsConsumer(consumer, {} as NotifyEventUseCase).onApplicationBootstrap();
    expect(subscribed.sort()).toEqual([
      'cleaning.booking.confirmed',
      'cleaning.mission.completed',
      'cleaning.mission.scheduled',
      'cleaning.quote.requested',
      'cleaning.quote.sent',
      'cleaning.request.cancelled',
      'cleaning.visit.scheduled',
    ]);
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
