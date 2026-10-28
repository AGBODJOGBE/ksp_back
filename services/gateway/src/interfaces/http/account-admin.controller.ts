import { Body, Controller, Inject } from '@nestjs/common';
import { type AccountAdminApi } from '../../application/identity/account-admin.ports';
import { ACCOUNT_ADMIN_API } from '../../tokens';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes /api/v1/admin/identity/accounts (back-office, ADR-029) : rôles et double authentification
 * contrôlés par le garde d'après le manifeste, puis revérifiés par identity. Le numéro voyage dans
 * le corps, jamais dans l'adresse (journalisée).
 */
@Controller()
export class AccountAdminHttpController {
  constructor(@Inject(ACCOUNT_ADMIN_API) private readonly accounts: AccountAdminApi) {}

  @Route('findAccountByPhone')
  findByPhone(@Body() body: unknown) {
    return this.accounts.findByPhone(parseBody(requestBodies.findAccountByPhone, body).phone);
  }
}
