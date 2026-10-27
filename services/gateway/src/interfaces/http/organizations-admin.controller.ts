import { Body, Controller, Inject, Param, Query } from '@nestjs/common';
import { type OrganizationsApi } from '../../application/identity/organizations.ports';
import { ORGANIZATIONS_API } from '../../tokens';
import { idFrom, pageFrom } from './cleaning.controller';
import { parseParam } from './cleaning-schemas';
import { organizationParams } from './organization-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

/**
 * Routes /api/v1/admin/identity/organizations (back-office, ADR-027) : rôles et double
 * authentification contrôlés par le garde d'après le manifeste, puis revérifiés par identity.
 */
@Controller()
export class OrganizationAdminHttpController {
  constructor(@Inject(ORGANIZATIONS_API) private readonly organizations: OrganizationsApi) {}

  @Route('listOrganizations')
  list(@Query() query: Query) {
    const status = parseParam(organizationParams.status, query['status'], 'status');
    return this.organizations.list(pageFrom(query), status);
  }

  @Route('getOrganization')
  get(@Param('id') id: unknown) {
    return this.organizations.get(idFrom(id));
  }

  @Route('validateOrganization')
  validate(@Param('id') id: unknown) {
    return this.organizations.decide(idFrom(id), 'validate');
  }

  @Route('rejectOrganization')
  reject(@Param('id') id: unknown, @Body() body: unknown) {
    const organizationId = idFrom(id);
    return this.organizations.decide(
      organizationId,
      'reject',
      parseBody(requestBodies.rejectOrganization, body).reason,
    );
  }

  @Route('suspendOrganization')
  suspend(@Param('id') id: unknown, @Body() body: unknown) {
    const organizationId = idFrom(id);
    return this.organizations.decide(
      organizationId,
      'suspend',
      parseBody(requestBodies.suspendOrganization, body).reason,
    );
  }

  @Route('reactivateOrganization')
  reactivate(@Param('id') id: unknown) {
    return this.organizations.decide(idFrom(id), 'reactivate');
  }
}
