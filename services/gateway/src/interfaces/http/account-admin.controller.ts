import { Body, Controller, Inject, Param, Query } from '@nestjs/common';
import { type AccountAdminApi } from '../../application/identity/account-admin.ports';
import { ACCOUNT_ADMIN_API } from '../../tokens';
import { roleParams } from './organization-schemas';
import { idFrom, parseParam } from './params';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes /api/v1/admin/identity/accounts, /roles et /permissions (back-office, ADR-029, ADR-043,
 * ADR-057) : rôles et double
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
    const { roleCode, reason, zoneKeys } = parseBody(requestBodies.grantAccountRole, body);
    return this.accounts.grantRole(userId, roleCode, reason, zoneKeys);
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

  // Rôles dynamiques du super administrateur (R-RB-01, R-RB-02 ; ADR-057).
  @Route('listPermissions')
  listPermissions(@Query() query: Record<string, unknown>) {
    const { service, includeRetired } = parseParam(
      roleParams.listPermissions,
      { service: query['service'], includeRetired: query['includeRetired'] },
      'service/includeRetired',
    );
    return this.accounts.listPermissions({
      ...(service ? { service } : {}),
      includeRetired: includeRetired === 'true',
    });
  }

  @Route('getRole')
  getRole(@Param('code') code: unknown) {
    return this.accounts.getRole(parseParam(roleParams.code, code, 'code'));
  }

  @Route('createRole')
  createRole(@Body() body: unknown) {
    return this.accounts.createRole(parseBody(requestBodies.createRole, body));
  }

  @Route('updateRole')
  updateRole(@Param('code') code: unknown, @Body() body: unknown) {
    const roleCode = parseParam(roleParams.code, code, 'code');
    return this.accounts.updateRole(roleCode, parseBody(requestBodies.updateRole, body));
  }

  @Route('deactivateRole')
  deactivateRole(@Param('code') code: unknown, @Body() body: unknown) {
    const roleCode = parseParam(roleParams.code, code, 'code');
    return this.accounts.deactivateRole(roleCode, parseBody(requestBodies.deactivateRole, body).reason);
  }
}
