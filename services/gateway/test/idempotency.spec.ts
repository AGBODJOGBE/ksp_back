import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { type RouteDefinition } from '../src/domain/routing/route-manifest';
import { AccountAdminHttpController } from '../src/interfaces/http/account-admin.controller';
import { BillingHttpController } from '../src/interfaces/http/billing.controller';
import { CleaningAdminHttpController } from '../src/interfaces/http/cleaning-admin.controller';
import { CleaningHttpController } from '../src/interfaces/http/cleaning.controller';
import { DocumentHttpController } from '../src/interfaces/http/document.controller';
import { FileHttpController } from '../src/interfaces/http/file.controller';
import { IdentityHttpController } from '../src/interfaces/http/identity.controller';
import { JwksHttpController } from '../src/interfaces/http/jwks.controller';
import { NotificationHttpController } from '../src/interfaces/http/notification.controller';
import { OrganizationAdminHttpController } from '../src/interfaces/http/organizations-admin.controller';
import { OrganizationHttpController } from '../src/interfaces/http/organizations.controller';
import { PaymentHttpController } from '../src/interfaces/http/payment.controller';
import { WalletHttpController } from '../src/interfaces/http/wallet.controller';
import { ROUTE_DEFINITION } from '../src/interfaces/http/route.guard';

const CONTROLLERS = [
  IdentityHttpController,
  JwksHttpController,
  OrganizationHttpController,
  OrganizationAdminHttpController,
  AccountAdminHttpController,
  CleaningHttpController,
  CleaningAdminHttpController,
  BillingHttpController,
  PaymentHttpController,
  NotificationHttpController,
  FileHttpController,
  WalletHttpController,
  DocumentHttpController,
];

/** Routes dont le contrôleur lit l'en-tête Idempotency-Key, et leur ligne du manifeste. */
function routes(): { route: RouteDefinition; readsKey: boolean }[] {
  return CONTROLLERS.flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype)
      .filter((name) => name !== 'constructor')
      .flatMap((name) => {
        const handler = (controller.prototype as Record<string, object>)[name]!;
        const route = Reflect.getMetadata(ROUTE_DEFINITION, handler) as RouteDefinition | undefined;
        if (!route) return [];
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
          string,
          { data?: unknown }
        >;
        const readsKey = Object.entries(args).some(
          ([key, arg]) => key.startsWith(`${RouteParamtypes.HEADERS}:`) && arg.data === 'idempotency-key',
        );
        return [{ route, readsKey }];
      }),
  );
}

describe('clé d’idempotence : manifeste et contrôleurs d’accord (ADR-051)', () => {
  it('une route transmet la clé si et seulement si le manifeste la déclare (la garde l’applique)', () => {
    const mismatches = routes()
      .filter(({ route, readsKey }) => readsKey !== Boolean(route.idempotencyKey))
      .map(
        ({ route, readsKey }) =>
          `${route.operationId} (lue : ${readsKey}, manifeste : ${route.idempotencyKey})`,
      );
    expect(mismatches).toEqual([]);
    expect(routes().filter(({ readsKey }) => readsKey).length).toBeGreaterThan(10);
  });
});
