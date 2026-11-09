import { Body, Controller, Inject, Param } from '@nestjs/common';
import { type AccountAdminApi } from '../../application/identity/account-admin.ports';
import { ACCOUNT_ADMIN_API } from '../../tokens';
import { idFrom } from './cleaning.controller';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes /api/v1/admin/identity/accounts et /roles (back-office, ADR-029, ADR-043) : rôles et double
 * authentification contrôlés par le garde d'après le manifeste, puis revérifiés par identity, qui
 * applique aussi le périmètre de l'appelant. Numéro et recherche voyagent dans le corps, jamais
 * dans l'adresse (journalisée).
 */
@Controller()
export class AccountAdminHttpController {
  constructor(@Inject(ACCOUNT_ADMIN_API) private readonly accounts: AccountAdminApi) {}

  @Route('findAccountByPhone')
  findByPhone(@Body() body: unknown) {
    return this.accounts.findByPhone(parseBody(requestBodies.findAccountByPhone, body).phone);
  }

  @Route('searchAccounts')
  search(@Body() body: unknown) {
    return this.accounts.search(parseBody(requestBodies.searchAccounts, body ?? {}));
  }

  @Route('getAccount')
  get(@Param('id') id: unknown) {
    return this.accounts.get(idFrom(id));
  }

  @Route('listAssignableRoles')
  listAssignableRoles() {
    return this.accounts.listAssignableRoles();
  }

  @Route('grantAccountRole')
  grantRole(@Param('id') id: unknown, @Body() body: unknown) {
    const userId = idFrom(id);
    const { roleCode, reason } = parseBody(requestBodies.grantAccountRole, body);
    return this.accounts.grantRole(userId, roleCode, reason);
  }

  @Route('revokeAccountRole')
  revokeRole(@Param('id') id: unknown, @Body() body: unknown) {
    const userId = idFrom(id);
    const { assignmentId, reason } = parseBody(requestBodies.revokeAccountRole, body);
    return this.accounts.revokeRole(userId, assignmentId, reason);
  }

  @Route('suspendAccount')
  suspend(@Param('id') id: unknown, @Body() body: unknown) {
    const userId = idFrom(id);
    return this.accounts.changeStatus(
      userId,
      'suspend',
      parseBody(requestBodies.suspendAccount, body).reason,
    );
  }

  @Route('reactivateAccount')
  reactivate(@Param('id') id: unknown, @Body() body: unknown) {
    const userId = idFrom(id);
    const { reason } = parseBody(requestBodies.reactivateAccount, body);
    return this.accounts.changeStatus(userId, 'reactivate', reason);
  }

  @Route('resetAccountMfa')
  resetMfa(@Param('id') id: unknown, @Body() body: unknown) {
    const userId = idFrom(id);
    return this.accounts.resetMfa(userId, parseBody(requestBodies.resetAccountMfa, body).reason);
  }
}
