import { type commonV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { NEVER, of, throwError } from 'rxjs';
import {
  GrpcObligationChecker,
  type ObligationTarget,
  parseObligationServices,
} from './grpc-obligation-checker';

const USER = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001';

function target(
  service: string,
  respond: (
    request: commonV1.HasPendingObligationsRequest,
  ) => ReturnType<commonV1.ObligationServiceClient['hasPendingObligations']>,
  requests: commonV1.HasPendingObligationsRequest[] = [],
): ObligationTarget {
  return {
    service,
    client: {
      hasPendingObligations: (request) => {
        requests.push(request);
        return respond(request);
      },
    },
    caller: new GrpcCaller({ target: service, defaultDeadlineMs: 50 }),
  };
}

const none = () => of({ hasPending: false, obligations: [] });

describe('GrpcObligationChecker (ksp.common.v1.ObligationService)', () => {
  it('aucune obligation nulle part : la suppression peut avoir lieu', async () => {
    const requests: commonV1.HasPendingObligationsRequest[] = [];
    const checker = new GrpcObligationChecker(
      [target('cleaning', none, requests), target('billing', none, requests)],
      50,
    );
    expect(await checker.check(USER)).toEqual({ status: 'clear' });
    expect(requests).toEqual([
      { userId: USER, organizationId: '' },
      { userId: USER, organizationId: '' },
    ]);
  });

  it('une seule réponse positive bloque, avec les raisons de chaque service', async () => {
    const checker = new GrpcObligationChecker(
      [
        target('cleaning', none),
        target('billing', () =>
          of({
            hasPending: true,
            obligations: [
              { kind: 'unpaid_invoice', reference: 'FAC-2026-000042', description: 'Facture impayée.' },
            ],
          }),
        ),
      ],
      50,
    );
    expect(await checker.check(USER)).toEqual({
      status: 'blocked',
      obstacles: [
        {
          service: 'billing',
          kind: 'unpaid_invoice',
          reference: 'FAC-2026-000042',
          description: 'Facture impayée.',
        },
      ],
    });
  });

  it('une réponse positive sans détail bloque quand même', async () => {
    const checker = new GrpcObligationChecker(
      [target('payment', () => of({ hasPending: true, obligations: [] }))],
      50,
    );
    expect(await checker.check(USER)).toMatchObject({
      status: 'blocked',
      obstacles: [{ service: 'payment', kind: 'pending_obligation' }],
    });
  });

  it('un service en panne, trop lent ou qui refuse l’appel rend le contrôle impossible', async () => {
    const checker = new GrpcObligationChecker(
      [
        target('cleaning', none),
        target('billing', () => throwError(() => AppError.unavailable('GRPC_UNAVAILABLE', 'panne'))),
        target('payment', () => NEVER),
        target('recovery', () => throwError(() => AppError.forbidden('RECOVERY_CALLER_FORBIDDEN', 'refusé'))),
      ],
      50,
    );
    expect(await checker.check(USER)).toEqual({
      status: 'unavailable',
      services: ['billing', 'payment', 'recovery'],
    });
  });

  it('l’injoignable l’emporte sur une obligation : réessayer plus tard', async () => {
    const checker = new GrpcObligationChecker(
      [
        target('billing', () => of({ hasPending: true, obligations: [] })),
        target('payment', () => throwError(() => AppError.unavailable('GRPC_UNAVAILABLE', 'panne'))),
      ],
      50,
    );
    expect((await checker.check(USER)).status).toBe('unavailable');
  });
});

describe('parseObligationServices', () => {
  it('lit « nom=hôte:port » séparés par des virgules', () => {
    expect(parseObligationServices(' cleaning=localhost:50053, billing=billing:50054 ,')).toEqual([
      { service: 'cleaning', url: 'localhost:50053' },
      { service: 'billing', url: 'billing:50054' },
    ]);
  });

  it('refuse une entrée mal formée', () => {
    expect(() => parseObligationServices('cleaning')).toThrow(/OBLIGATION_SERVICES/);
    expect(() => parseObligationServices('Cleaning=x:1')).toThrow(/OBLIGATION_SERVICES/);
  });
});
