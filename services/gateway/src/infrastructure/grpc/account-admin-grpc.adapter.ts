import { type Metadata } from '@grpc/grpc-js';
import { type identityV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type AccountAdminApi } from '../../application/identity/account-admin.ports';
import { type Json } from '../../application/cleaning/cleaning.ports';
import { USER_STATUS } from './identity-grpc.adapter';
import { toUpstreamError } from './upstream-error';

/** Réponse d'identity qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse d'identity inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);

/** Compte trouvé, au format du contrat OpenAPI (AdminAccountMatch). */
export function presentAccountMatch(value: identityV1.AccountMatch | undefined) {
  if (!value) throw malformed('compte');
  const status = USER_STATUS[value.status];
  if (!status) throw malformed(`état ${value.status}`);
  return {
    userId: value.userId,
    status,
    firstName: orNull(value.firstName),
    lastName: orNull(value.lastName),
    phoneMasked: value.phoneMasked,
  };
}

/**
 * Client gRPC de la recherche de compte (identity.AccountAdminService) : délai, coupe-circuit et
 * jeton de service par GrpcCaller. Lecture rejouable. Aucun journal du numéro recherché.
 */
export class AccountAdminGrpcAdapter implements AccountAdminApi {
  private readonly logger = new Logger('IdentityAccountAdminGrpc');

  constructor(
    private readonly client: identityV1.AccountAdminServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async findByPhone(phone: string): Promise<Json> {
    const res = await this.read('findAccountByPhone', (m) =>
      this.client.findAccountByPhone({ phoneE164: phone }, m),
    );
    return presentAccountMatch(res.account);
  }

  private async read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    try {
      return await this.caller.call(name, invoke, { idempotent: true });
    } catch (error) {
      const upstream = toUpstreamError('identity', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`identity.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
