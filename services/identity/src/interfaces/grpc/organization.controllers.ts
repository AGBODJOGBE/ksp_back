import { identityV1 } from '@ksp/contracts';
import { currentContext, requireUser } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import {
  DecideOrganizationUseCase,
  GetOrganizationUseCase,
  ListOrganizationsUseCase,
} from '../../application/organization/organization-admin.use-cases';
import {
  ChangeOrganizationBillingEmailUseCase,
  ConfirmOrganizationBillingEmailUseCase,
  CreateOrganizationUseCase,
  GetMyOrganizationUseCase,
  ListMyOrganizationsUseCase,
} from '../../application/organization/organization.use-cases';
import { type OrganizationStatus } from '../../domain/organization/organization';
import { ORGANIZATION_STATUS, toMemberMessage, toMembershipMessage, toOrganizationMessage } from './mappers';

const STATUS_IN = Object.fromEntries(
  Object.entries(ORGANIZATION_STATUS).map(([status, value]) => [value, status]),
) as Partial<Record<identityV1.OrganizationStatus, OrganizationStatus>>;

/**
 * Adaptateur gRPC des organisations de l'utilisateur connecté (portail), réservé à la gateway.
 * L'utilisateur vient toujours du contexte transmis par la gateway, jamais du message.
 */
@Controller()
@identityV1.OrganizationServiceControllerMethods()
export class OrganizationGrpcController implements identityV1.OrganizationServiceController {
  constructor(
    private readonly createOrganizationUseCase: CreateOrganizationUseCase,
    private readonly listMyOrganizationsUseCase: ListMyOrganizationsUseCase,
    private readonly getMyOrganizationUseCase: GetMyOrganizationUseCase,
    private readonly changeBillingEmailUseCase: ChangeOrganizationBillingEmailUseCase,
    private readonly confirmBillingEmailUseCase: ConfirmOrganizationBillingEmailUseCase,
  ) {}

  async createOrganization(
    request: identityV1.CreateOrganizationRequest,
  ): Promise<identityV1.CreateOrganizationResponse> {
    const membership = await this.createOrganizationUseCase.execute({
      userId: requireUser().userId,
      legalName: request.legalName,
      address: request.address,
      ifu: request.ifu,
      rccm: request.rccm,
    });
    return { membership: toMembershipMessage(membership) };
  }

  async listMyOrganizations(): Promise<identityV1.ListMyOrganizationsResponse> {
    const memberships = await this.listMyOrganizationsUseCase.execute(requireUser().userId);
    return { memberships: memberships.map(toMembershipMessage) };
  }

  async getMyOrganization(
    request: identityV1.GetMyOrganizationRequest,
  ): Promise<identityV1.GetMyOrganizationResponse> {
    const membership = await this.getMyOrganizationUseCase.execute(
      requireUser().userId,
      request.organizationId,
    );
    return { membership: toMembershipMessage(membership) };
  }

  async changeOrganizationBillingEmail(
    request: identityV1.ChangeOrganizationBillingEmailRequest,
  ): Promise<identityV1.ChangeOrganizationBillingEmailResponse> {
    const result = await this.changeBillingEmailUseCase.execute({
      userId: requireUser().userId,
      organizationId: request.organizationId,
      email: request.email,
      ip: currentContext()?.client?.ip ?? null,
    });
    return {
      pendingEmail: result.pendingEmail,
      expiresInSeconds: result.expiresInSeconds,
      resendAfterSeconds: result.resendAfterSeconds,
    };
  }

  async confirmOrganizationBillingEmail(
    request: identityV1.ConfirmOrganizationBillingEmailRequest,
  ): Promise<identityV1.ConfirmOrganizationBillingEmailResponse> {
    const membership = await this.confirmBillingEmailUseCase.execute({
      userId: requireUser().userId,
      organizationId: request.organizationId,
      code: request.code,
    });
    return { membership: toMembershipMessage(membership) };
  }
}

/**
 * Adaptateur gRPC de la validation des comptes entreprise (back-office), réservé à la gateway.
 * Rôles et double authentification revérifiés par les cas d'usage.
 */
@Controller()
@identityV1.OrganizationAdminServiceControllerMethods()
export class OrganizationAdminGrpcController implements identityV1.OrganizationAdminServiceController {
  constructor(
    private readonly listOrganizationsUseCase: ListOrganizationsUseCase,
    private readonly getOrganizationUseCase: GetOrganizationUseCase,
    private readonly decideOrganizationUseCase: DecideOrganizationUseCase,
  ) {}

  async listOrganizations(
    request: identityV1.ListOrganizationsRequest,
  ): Promise<identityV1.ListOrganizationsResponse> {
    const page = await this.listOrganizationsUseCase.execute({
      status: STATUS_IN[request.status] ?? null,
      limit: request.limit,
      cursor: request.cursor,
    });
    return { organizations: page.items.map(toOrganizationMessage), nextCursor: page.nextCursor ?? '' };
  }

  async getOrganization(
    request: identityV1.GetOrganizationRequest,
  ): Promise<identityV1.GetOrganizationResponse> {
    const detail = await this.getOrganizationUseCase.execute(request.organizationId);
    return {
      organization: toOrganizationMessage(detail.organization),
      members: detail.members.map(toMemberMessage),
    };
  }

  async validateOrganization(
    request: identityV1.ValidateOrganizationRequest,
  ): Promise<identityV1.ValidateOrganizationResponse> {
    return this.decide(request.organizationId, 'validate');
  }

  async rejectOrganization(
    request: identityV1.RejectOrganizationRequest,
  ): Promise<identityV1.RejectOrganizationResponse> {
    return this.decide(request.organizationId, 'reject', request.reason);
  }

  async suspendOrganization(
    request: identityV1.SuspendOrganizationRequest,
  ): Promise<identityV1.SuspendOrganizationResponse> {
    return this.decide(request.organizationId, 'suspend', request.reason);
  }

  async reactivateOrganization(
    request: identityV1.ReactivateOrganizationRequest,
  ): Promise<identityV1.ReactivateOrganizationResponse> {
    return this.decide(request.organizationId, 'reactivate');
  }

  private async decide(
    organizationId: string,
    decision: 'validate' | 'reject' | 'suspend' | 'reactivate',
    reason?: string,
  ): Promise<{ organization: identityV1.Organization }> {
    const organization = await this.decideOrganizationUseCase.execute({
      organizationId,
      decision,
      ...(reason !== undefined ? { reason } : {}),
    });
    return { organization: toOrganizationMessage(organization) };
  }
}
