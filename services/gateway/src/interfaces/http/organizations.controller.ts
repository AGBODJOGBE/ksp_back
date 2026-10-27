import { Body, Controller, Inject, Param } from '@nestjs/common';
import { type OrganizationsApi } from '../../application/identity/organizations.ports';
import { ORGANIZATIONS_API } from '../../tokens';
import { idFrom } from './cleaning.controller';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes des comptes entreprise du client (ADR-027) : changement de contexte, organisations et
 * e-mail de facturation. identity revérifie toujours l'appartenance et l'état de l'organisation.
 */
@Controller()
export class OrganizationHttpController {
  constructor(@Inject(ORGANIZATIONS_API) private readonly organizations: OrganizationsApi) {}

  /** Nouveau jeton d'accès dans le contexte demandé ; le jeton de renouvellement ne change pas. */
  @Route('switchContext')
  switchContext(@Body() body: unknown) {
    return this.organizations.switchContext(parseBody(requestBodies.switchContext, body).organizationId);
  }

  @Route('listMyOrganizations')
  listMine() {
    return this.organizations.listMine();
  }

  @Route('createOrganization')
  create(@Body() body: unknown) {
    return this.organizations.create(parseBody(requestBodies.createOrganization, body));
  }

  @Route('getMyOrganization')
  getMine(@Param('id') id: unknown) {
    return this.organizations.getMine(idFrom(id));
  }

  @Route('changeOrganizationBillingEmail')
  changeBillingEmail(@Param('id') id: unknown, @Body() body: unknown) {
    const organizationId = idFrom(id);
    return this.organizations.changeBillingEmail(
      organizationId,
      parseBody(requestBodies.changeOrganizationBillingEmail, body).email,
    );
  }

  @Route('confirmOrganizationBillingEmail')
  confirmBillingEmail(@Param('id') id: unknown, @Body() body: unknown) {
    const organizationId = idFrom(id);
    return this.organizations.confirmBillingEmail(
      organizationId,
      parseBody(requestBodies.confirmOrganizationBillingEmail, body).code,
    );
  }
}
