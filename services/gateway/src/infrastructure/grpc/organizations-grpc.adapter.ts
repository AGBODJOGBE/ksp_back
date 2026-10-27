import { type Metadata } from '@grpc/grpc-js';
import { identityV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json, type Page } from '../../application/cleaning/cleaning.ports';
import {
  type NewOrganization,
  type OrganizationDecision,
  type OrganizationsApi,
} from '../../application/identity/organizations.ports';
import { toActiveContext } from './identity-grpc.adapter';
import { toUpstreamError } from './upstream-error';

export interface OrganizationClients {
  auth: identityV1.AuthServiceClient;
  organizations: identityV1.OrganizationServiceClient;
  admin: identityV1.OrganizationAdminServiceClient;
}

/** Réponse d'identity qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse d'identity inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);

const STATUS_OUT: Partial<Record<identityV1.OrganizationStatus, string>> = {
  [identityV1.OrganizationStatus.ORGANIZATION_STATUS_PENDING_REVIEW]: 'pending_review',
  [identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE]: 'active',
  [identityV1.OrganizationStatus.ORGANIZATION_STATUS_REJECTED]: 'rejected',
  [identityV1.OrganizationStatus.ORGANIZATION_STATUS_SUSPENDED]: 'suspended',
};
const STATUS_IN: Record<string, identityV1.OrganizationStatus> = {
  pending_review: identityV1.OrganizationStatus.ORGANIZATION_STATUS_PENDING_REVIEW,
  active: identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE,
  rejected: identityV1.OrganizationStatus.ORGANIZATION_STATUS_REJECTED,
  suspended: identityV1.OrganizationStatus.ORGANIZATION_STATUS_SUSPENDED,
};
const ROLE_OUT: Partial<Record<identityV1.OrgRole, string>> = {
  [identityV1.OrgRole.ORG_ROLE_ADMIN]: 'org_admin',
  [identityV1.OrgRole.ORG_ROLE_MEMBER]: 'org_member',
  [identityV1.OrgRole.ORG_ROLE_VIEWER]: 'org_viewer',
};

function status(value: identityV1.OrganizationStatus): string {
  const known = STATUS_OUT[value];
  if (!known) throw malformed(`état ${value}`);
  return known;
}

function role(value: identityV1.OrgRole): string {
  const known = ROLE_OUT[value];
  if (!known) throw malformed(`rôle ${value}`);
  return known;
}

/** Organisation vue par l'un de ses membres : sans les identifiants des comptes du back-office. */
export function presentOrganization(value: identityV1.Organization | undefined) {
  if (!value) throw malformed('organisation');
  return {
    id: value.id,
    legalName: value.legalName,
    address: value.address,
    ifu: value.ifu,
    rccm: orNull(value.rccm),
    billingEmail: orNull(value.billingEmail),
    status: status(value.status),
    rejectionReason: orNull(value.rejectionReason),
    suspensionReason: orNull(value.suspensionReason),
    createdAt: value.createdAt,
    reviewedAt: orNull(value.reviewedAt),
  };
}

/** Organisation vue par le back-office : demandeur, auteur de la décision, suspension. */
export function presentAdminOrganization(value: identityV1.Organization | undefined) {
  if (!value) throw malformed('organisation');
  return {
    ...presentOrganization(value),
    createdBy: value.createdBy,
    reviewedBy: orNull(value.reviewedBy),
    suspendedAt: orNull(value.suspendedAt),
  };
}

export function presentMembership(value: identityV1.OrganizationMembership | undefined) {
  if (!value) throw malformed('appartenance');
  return {
    organization: presentOrganization(value.organization),
    role: role(value.role),
    pendingBillingEmail: orNull(value.pendingBillingEmail),
  };
}

function presentMember(value: identityV1.OrganizationMember) {
  return {
    userId: value.userId,
    role: role(value.role),
    firstName: orNull(value.firstName),
    lastName: orNull(value.lastName),
    phone: orNull(value.phoneE164),
    joinedAt: value.joinedAt,
  };
}

/**
 * Client gRPC des comptes entreprise d'identity (AuthService.SwitchContext, OrganizationService,
 * OrganizationAdminService) : délai, coupe-circuit et jeton de service par GrpcCaller. Seules les
 * lectures sont rejouées ; une écriture (création, décision, code) ne l'est jamais.
 */
export class OrganizationsGrpcAdapter implements OrganizationsApi {
  private readonly logger = new Logger('IdentityOrganizationsGrpc');

  constructor(
    private readonly clients: OrganizationClients,
    private readonly caller: GrpcCaller,
  ) {}

  async switchContext(organizationId: string | null): Promise<Json> {
    const res = await this.write('switchContext', (m) =>
      this.clients.auth.switchContext({ organizationId: organizationId ?? '' }, m),
    );
    const context = toActiveContext(res.activeContext);
    return {
      accessToken: res.accessToken,
      accessTokenExpiresAt: res.accessTokenExpiresAt,
      activeContext: {
        type: context.type,
        organizationId: context.organizationId,
        organizationName: context.organizationName,
      },
    };
  }

  async listMine(): Promise<Json> {
    const res = await this.read('listMyOrganizations', (m) =>
      this.clients.organizations.listMyOrganizations({}, m),
    );
    return { data: res.memberships.map(presentMembership) };
  }

  async create(input: NewOrganization): Promise<Json> {
    const res = await this.write('createOrganization', (m) =>
      this.clients.organizations.createOrganization(
        { legalName: input.legalName, address: input.address, ifu: input.ifu, rccm: input.rccm ?? '' },
        m,
      ),
    );
    return presentMembership(res.membership);
  }

  async getMine(id: string): Promise<Json> {
    const res = await this.read('getMyOrganization', (m) =>
      this.clients.organizations.getMyOrganization({ organizationId: id }, m),
    );
    return presentMembership(res.membership);
  }

  async changeBillingEmail(id: string, email: string): Promise<Json> {
    const res = await this.write('changeOrganizationBillingEmail', (m) =>
      this.clients.organizations.changeOrganizationBillingEmail({ organizationId: id, email }, m),
    );
    return {
      pendingEmail: res.pendingEmail,
      expiresInSeconds: res.expiresInSeconds,
      resendAfterSeconds: res.resendAfterSeconds,
    };
  }

  async confirmBillingEmail(id: string, code: string): Promise<Json> {
    const res = await this.write('confirmOrganizationBillingEmail', (m) =>
      this.clients.organizations.confirmOrganizationBillingEmail({ organizationId: id, code }, m),
    );
    return presentMembership(res.membership);
  }

  async list(value: Page, filter: string | undefined): Promise<Json> {
    const res = await this.read('listOrganizations', (m) =>
      this.clients.admin.listOrganizations(
        {
          status: filter ? STATUS_IN[filter]! : identityV1.OrganizationStatus.ORGANIZATION_STATUS_UNSPECIFIED,
          limit: value.limit ?? 0,
          cursor: value.cursor ?? '',
        },
        m,
      ),
    );
    return { data: res.organizations.map(presentAdminOrganization), nextCursor: res.nextCursor || null };
  }

  async get(id: string): Promise<Json> {
    const res = await this.read('getOrganization', (m) =>
      this.clients.admin.getOrganization({ organizationId: id }, m),
    );
    return {
      organization: presentAdminOrganization(res.organization),
      members: res.members.map(presentMember),
    };
  }

  async decide(id: string, decision: OrganizationDecision, reason?: string): Promise<Json> {
    const organizationId = id;
    const res = await this.write(`${decision}Organization`, (m) => {
      switch (decision) {
        case 'validate':
          return this.clients.admin.validateOrganization({ organizationId }, m);
        case 'reject':
          return this.clients.admin.rejectOrganization({ organizationId, reason: reason ?? '' }, m);
        case 'suspend':
          return this.clients.admin.suspendOrganization({ organizationId, reason: reason ?? '' }, m);
        case 'reactivate':
          return this.clients.admin.reactivateOrganization({ organizationId }, m);
      }
    });
    return presentAdminOrganization(res.organization);
  }

  // --- Appels -----------------------------------------------------------------------------------

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true });
  }

  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, {});
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('identity', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`identity.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
