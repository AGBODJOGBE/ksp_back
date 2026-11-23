import { createUseCases } from './use-cases';
import { asService, CREDITOR_ID, makeDeps, ORGANIZATION_ID, rejection } from './testing/fakes';

describe('obligations avant la suppression d’un compte (UC-ID-11)', () => {
  it('un dossier ouvert du compte ou de l’organisation bloque ; rien sinon', async () => {
    const deps = makeDeps();
    deps.obligations.open.set(`user:${CREDITOR_ID}`, [{ number: 'RC-000123' }]);
    deps.obligations.open.set(`organization:${ORGANIZATION_ID}`, [
      { number: 'RC-000200' },
      { number: 'RC-000201' },
    ]);
    const useCases = createUseCases(deps);
    const ask = (organizationId = '') =>
      asService('identity', () =>
        useCases.hasPendingObligations.execute({ userId: CREDITOR_ID, organizationId }),
      );
    expect(await ask()).toEqual([
      {
        kind: 'open_recovery_case',
        reference: 'RC-000123',
        description: 'Le dossier de recouvrement RC-000123 est en cours : arrêtez-le ou attendez sa clôture.',
      },
    ]);
    expect((await ask(ORGANIZATION_ID)).map((o) => o.reference)).toEqual(['RC-000200', 'RC-000201']);
    deps.obligations.open.clear();
    expect(await ask()).toEqual([]);
  });

  it('réservé à identity', async () => {
    const useCases = createUseCases(makeDeps());
    const error = await rejection(
      asService('cleaning', () =>
        useCases.hasPendingObligations.execute({ userId: CREDITOR_ID, organizationId: '' }),
      ),
    );
    expect(error.code).toBe('RECOVERY_CALLER_FORBIDDEN');
  });
});
