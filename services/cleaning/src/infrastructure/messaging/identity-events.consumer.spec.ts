import { type RabbitMqConsumer } from '@ksp/platform';
import { type CleaningUseCases } from '../../application/use-cases';
import { IdentityEventsConsumer } from './identity-events.consumer';

type Handler = (envelope: {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: { organizationId: string };
}) => Promise<void>;

describe('IdentityEventsConsumer (ADR-030)', () => {
  it('suspension et réactivation d’une organisation : état transmis au cas d’usage', async () => {
    const handlers = new Map<string, Handler>();
    const consumer = {
      subscribe: jest.fn(async (type: string, handler: Handler) => {
        handlers.set(type, handler);
      }),
    };
    const execute = jest.fn(async () => ({ examined: 2, changed: 1 }));
    const useCases = { handleOrganizationEvent: { execute } } as unknown as CleaningUseCases;
    await new IdentityEventsConsumer(
      consumer as unknown as RabbitMqConsumer,
      useCases,
    ).onApplicationBootstrap();

    expect([...handlers.keys()]).toEqual([
      'identity.organization.suspended',
      'identity.organization.reactivated',
    ]);
    const organizationId = '0192f1c4-7a2b-7c3d-8e4f-000000000777';
    for (const [type, suspended] of [
      ['identity.organization.suspended', true],
      ['identity.organization.reactivated', false],
    ] as const) {
      await handlers.get(type)!({
        eventId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
        type,
        occurredAt: '2026-10-28T09:00:00.000Z',
        payload: { organizationId },
      });
      expect(execute).toHaveBeenLastCalledWith({
        eventId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
        eventType: type,
        organizationId,
        suspended,
        occurredAt: '2026-10-28T09:00:00.000Z',
      });
    }
  });

  it('échec du cas d’usage : l’erreur remonte pour que le message soit retraité', async () => {
    let handler: Handler | undefined;
    const consumer = {
      subscribe: jest.fn(async (type: string, h: Handler) => {
        if (type === 'identity.organization.suspended') handler = h;
      }),
    };
    const useCases = {
      handleOrganizationEvent: {
        execute: jest.fn(async () => Promise.reject(new Error('base indisponible'))),
      },
    } as unknown as CleaningUseCases;
    await new IdentityEventsConsumer(
      consumer as unknown as RabbitMqConsumer,
      useCases,
    ).onApplicationBootstrap();
    await expect(
      handler!({
        eventId: '0192f1c4-7a2b-7c3d-8e4f-000000000002',
        type: 'identity.organization.suspended',
        occurredAt: '2026-10-28T09:00:00.000Z',
        payload: { organizationId: '0192f1c4-7a2b-7c3d-8e4f-000000000777' },
      }),
    ).rejects.toThrow('base indisponible');
  });
});
