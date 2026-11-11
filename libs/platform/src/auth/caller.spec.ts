import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { firstValueFrom, of } from 'rxjs';
import { runWithContext, type UserContext } from '../context/request-context';
import { allowedCallersOf, AllowedCallers, requireCaller } from './caller';

/** Rôles et double authentification qu'un service pourrait forger dans les métadonnées. */
const forgedAdmin: UserContext = {
  userId: 'u-1',
  sessionId: 's-1',
  activeContext: 'personal',
  roles: [{ role: 'super_admin', scopeType: 'global' }],
  mfa: true,
  authTime: Math.floor(Date.now() / 1000),
};

@AllowedCallers('gateway')
class BackofficeController {}

class InternalController {}

/** Appel du contrôleur au travers de son intercepteur, dans le contexte donné. */
function call(callerService: string | undefined): Promise<unknown> {
  const [interceptor] = Reflect.getMetadata(INTERCEPTORS_METADATA, BackofficeController) as {
    intercept(context: ExecutionContext, next: CallHandler): ReturnType<CallHandler['handle']>;
  }[];
  return runWithContext(
    { correlationId: 'c', user: forgedAdmin, ...(callerService ? { callerService } : {}) },
    () => firstValueFrom(interceptor!.intercept({} as ExecutionContext, { handle: () => of('ok') })),
  );
}

describe('appelants autorisés (ADR-050)', () => {
  it('refuse un service autre que la gateway, même avec des rôles d’administrateur', async () => {
    await expect(call('cleaning')).rejects.toMatchObject({
      code: 'AUTH_CALLER_FORBIDDEN',
      kind: 'PERMISSION_DENIED',
    });
  });

  it('laisse passer la gateway, et l’appelant inconnu du développement sans jetons', async () => {
    await expect(call('gateway')).resolves.toBe('ok');
    await expect(call(undefined)).resolves.toBe('ok');
  });

  it('expose la restriction de chaque contrôleur', () => {
    expect(allowedCallersOf(BackofficeController)).toEqual(['gateway']);
    expect(allowedCallersOf(InternalController)).toBeUndefined();
  });

  it('requireCaller renvoie l’appelant autorisé', () => {
    runWithContext({ correlationId: 'c', callerService: 'document' }, () => {
      expect(requireCaller(['document', 'recovery'])).toBe('document');
      expect(() => requireCaller(['gateway'])).toThrow(
        expect.objectContaining({ code: 'AUTH_CALLER_FORBIDDEN' }),
      );
    });
  });
});
