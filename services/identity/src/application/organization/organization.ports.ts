import {
  type Organization,
  type OrganizationDecision,
  type OrganizationStatus,
  type OrgRole,
} from '../../domain/organization/organization';

/** Une organisation vue par l'un de ses membres, avec son rôle. */
export interface Membership {
  organization: Organization;
  role: OrgRole;
}

/** Demande de création : l'organisation en attente de validation et son administrateur. */
export interface NewOrganization {
  id: string;
  legalName: string;
  address: string;
  ifu: string;
  rccm: string | null;
  createdBy: string;
  memberId: string;
  now: Date;
}

/** Un membre vu par le back-office, avec ses coordonnées. */
export interface OrganizationMemberView {
  userId: string;
  role: OrgRole;
  firstName: string | null;
  lastName: string | null;
  phoneE164: string | null;
  joinedAt: Date;
}

export interface OrganizationPage {
  items: Organization[];
  /** Identifiant de la dernière organisation de la page ; null pour la dernière page. */
  nextCursor: string | null;
}

/** Décision du back-office, appliquée si l'organisation est toujours dans l'état `from`. */
export interface OrganizationStatusChange {
  organizationId: string;
  decision: OrganizationDecision;
  from: OrganizationStatus;
  to: OrganizationStatus;
  actorId: string;
  /** Motif d'un refus ou d'une suspension ; null sinon. */
  reason: string | null;
  auditId: string;
  now: Date;
}

/** Un IFU n'appartient qu'à une organisation non refusée (index unique partiel). */
export class OrganizationIfuTakenError extends Error {
  override readonly name = 'OrganizationIfuTakenError';
}

/** L'organisation a changé d'état entre la lecture et la décision (deux décisions simultanées). */
export class OrganizationChangedError extends Error {
  override readonly name = 'OrganizationChangedError';
}

export interface OrganizationRepository {
  /** Demandes encore en attente de validation créées par ce compte. */
  countPendingCreatedBy(userId: string): Promise<number>;
  /**
   * Crée l'organisation (en attente) et son administrateur, et écrit les événements
   * identity.organization.created et identity.member.added, en une transaction.
   * Lève OrganizationIfuTakenError.
   */
  create(organization: NewOrganization): Promise<Membership>;
  findById(organizationId: string): Promise<Organization | null>;
  /** Appartenance active du compte à l'organisation, quel que soit l'état de celle-ci. */
  membership(userId: string, organizationId: string): Promise<Membership | null>;
  /** Organisations dont le compte est membre, les plus récentes d'abord. */
  memberships(userId: string): Promise<Membership[]>;
  /** Organisations, les plus récentes d'abord (identifiants UUID v7), après le curseur. */
  list(
    filter: { status: OrganizationStatus | null },
    page: { limit: number; cursor: string | null },
  ): Promise<OrganizationPage>;
  /** Membres actifs, avec leurs coordonnées. */
  members(organizationId: string): Promise<OrganizationMemberView[]>;
  /**
   * Applique la décision si l'organisation est toujours dans l'état de départ, et écrit dans la
   * même transaction l'événement de la décision et la trace d'audit. Lève OrganizationChangedError.
   */
  applyDecision(change: OrganizationStatusChange): Promise<Organization>;
}
