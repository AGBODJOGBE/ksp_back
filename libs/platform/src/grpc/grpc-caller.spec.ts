import { type Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { NEVER, of, throwError } from 'rxjs';
import { runWithContext } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { toGrpcErrorPayload } from '../errors/grpc-error';
import { GrpcCaller } from './grpc-caller';

const unavailable = () => ({ code: GrpcStatus.UNAVAILABLE, details: 'connection refused' });

describe('GrpcCaller', () => {
  it('transmet le contexte et le jeton de service dans les métadonnées', async () => {
    const caller = new GrpcCaller({
      target: 'notification',
      serviceTokenProvider: { getToken: async (audience) => `token-for-${audience}` },
    });
    let seen: Metadata | undefined;
    await runWithContext({ correlationId: 'corr-42' }, () =>
      caller.call('SendNotification', (metadata) => {
        seen = metadata;
        return of({ ok: true });
      }),
    );
    expect(seen?.get('x-correlation-id')).toEqual(['corr-42']);
    expect(seen?.get('authorization')).toEqual(['Bearer token-for-notification']);
  });

  it('coupe un appel qui dépasse le délai', async () => {
    const caller = new GrpcCaller({ target: 'identity' });
    await expect(caller.call('GetUser', () => NEVER, { deadlineMs: 20 })).rejects.toMatchObject({
      kind: 'DEADLINE_EXCEEDED',
    });
  });

  it('rejoue une lecture après une panne réseau', async () => {
    const caller = new GrpcCaller({ target: 'identity', retryBackoffMs: 1 });
    let calls = 0;
    const result = await caller.call('GetUser', () => (++calls === 1 ? throwError(unavailable) : of('ok')), {
      idempotent: true,
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('ne rejoue jamais une écriture', async () => {
    const caller = new GrpcCaller({ target: 'wallet', retryBackoffMs: 1 });
    let calls = 0;
    await expect(
      caller.call('HoldFunds', () => {
        calls += 1;
        return throwError(unavailable);
      }),
    ).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(calls).toBe(1);
  });

  it('rend l’erreur métier du service appelé, sans la rejouer', async () => {
    const caller = new GrpcCaller({ target: 'identity', retryBackoffMs: 1 });
    const notFound = toGrpcErrorPayload(AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'));
    let calls = 0;
    await expect(
      caller.call(
        'GetUser',
        () => {
          calls += 1;
          return throwError(() => notFound);
        },
        { idempotent: true },
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_USER_NOT_FOUND' });
    expect(calls).toBe(1);
  });

  it('ouvre le coupe-circuit après une série de pannes, puis répond immédiatement', async () => {
    const caller = new GrpcCaller({
      target: 'payment',
      breaker: { volumeThreshold: 3, errorThresholdPercentage: 50 },
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(caller.call('CreatePaymentIntent', () => throwError(unavailable))).rejects.toBeDefined();
    }
    expect(caller.isOpen).toBe(true);
    let invoked = false;
    await expect(
      caller.call('CreatePaymentIntent', () => {
        invoked = true;
        return of('ok');
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_UNAVAILABLE' });
    expect(invoked).toBe(false);
  });

  it('n’ouvre pas le coupe-circuit pour des erreurs métier', async () => {
    const caller = new GrpcCaller({ target: 'identity', breaker: { volumeThreshold: 3 } });
    const notFound = toGrpcErrorPayload(AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'));
    for (let i = 0; i < 5; i += 1) {
      await expect(caller.call('GetUser', () => throwError(() => notFound))).rejects.toBeDefined();
    }
    expect(caller.isOpen).toBe(false);
  });
});
