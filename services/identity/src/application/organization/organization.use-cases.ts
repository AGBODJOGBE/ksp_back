import {
  acceptsBillingEmail,
  MAX_PENDING_REQUESTS,
  normalizeAddress,
  normalizeIfu,
  normalizeLegalName,
  normalizeRccm,
  type Organization,
  type OrgRole,
} from '../../domain/organization/organization';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { EmailAddress } from '../../domain/user/email-address';
import { isUuid } from '../context/active-contexts';
import { checkEmailCode } from '../email/email-code-check';
import { EmailCodeIssuer, type IssuedEmailCode } from '../email/email-code-issuer';
import { emailErrors } from '../email/email-errors';
import {
  type EmailCodeSender,
  type EmailVerificationRepository,
  VerificationAlreadyConsumedError,
} from '../email/email.ports';
import { type PendingEmails } from '../email/pending-email';
import { type OtpCodeGenerator, type OtpHasher } from '../otp/otp.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { organizationErrors } from './organization-errors';
import {
  type Membership,
  OrganizationIfuTakenError,
  type OrganizationRepository,
} from './organization.ports';

/** Une organisation vue par l'un de ses membres, avec l'e-mail de facturation en attente. */
export interface MembershipView {
  organization: Organization;
  role: OrgRole;
  /** E-mail de facturation en attente de confirmation ; null s'il n'y en a pas. */
  pendingBillingEmail: string | null;
}

async function view(membership: Membership, pendingEmails: PendingEmails): Promise<MembershipView> {
  return { ...membership, pendingBillingEmail: await pendingEmails.ofOrganization(membership.organization) };
}

/** Appartenance de l'appelant ; une organisation dont il n'est pas membre est introuvable pour lui. */
async function ownMembership(
  organizations: OrganizationRepository,
  userId: string,
  organizationId: string,
): Promise<Membership> {
  if (!isUuid(organizationId)) throw organizationErrors.notFound();
  const membership = await organizations.membership(userId, organizationId);
  if (!membership) throw organizationErrors.notFound();
  return membership;
}

/** L'e-mail de facturation se gère par un administrateur, tant que l'organisation l'accepte. */
async function adminMembership(
  organizations: OrganizationRepository,
  userId: string,
  organizationId: string,
): Promise<Membership> {
  const membership = await ownMembership(organizations, userId, organizationId);
  if (membership.role !== 'org_admin') throw organizationErrors.forbidden();
  const { status } = membership.organization;
  if (!acceptsBillingEmail(status)) throw organizationErrors.notActive(status);
  return membership;
}

export interface CreateOrganizationInput {
  userId: string;
  legalName: string;
  address: string;
  ifu: string;
  /** Vide : non renseigné. */
  rccm: string;
}

/**
 * UC-ID-12 : demander la création d'un compte entreprise depuis le portail. L'organisation attend
 * la validation d'un admin KSP ; le demandeur en devient l'administrateur. Un IFU n'appartient
 * qu'à une organisation non refusée, et un compte a au plus MAX_PENDING_REQUESTS demandes en attente.
 */
export class CreateOrganizationUseCase {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly pendingEmails: PendingEmails,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: CreateOrganizationInput): Promise<MembershipView> {
    const legalName = normalizeLegalName(input.legalName);
    if (!legalName) {
      throw organizationErrors.invalid(
        'legalName',
        'La raison sociale est invalide (200 caractères au plus).',
      );
    }
    const address = normalizeAddress(input.address);
    if (!address)
      throw organizationErrors.invalid('address', "L'adresse est invalide (300 caractères au plus).");
    const ifu = normalizeIfu(input.ifu);
    if (!ifu) throw organizationErrors.invalid('ifu', "L'IFU doit compter 13 chiffres.");
    let rccm: string | null = null;
    if (input.rccm.trim()) {
      rccm = normalizeRccm(input.rccm);
      if (!rccm)
        throw organizationErrors.invalid('rccm', 'Le RCCM est invalide, par exemple RB/COT/19 B 12345.');
    }

    if ((await this.organizations.countPendingCreatedBy(input.userId)) >= MAX_PENDING_REQUESTS) {
      throw organizationErrors.tooManyPending();
    }
    try {
      const membership = await this.organizations.create({
        id: this.ids.next(),
        legalName,
        address,
        ifu,
        rccm,
        createdBy: input.userId,
        memberId: this.ids.next(),
        now: this.clock.now(),
      });
      return view(membership, this.pendingEmails);
    } catch (error) {
      if (error instanceof OrganizationIfuTakenError) throw organizationErrors.alreadyExists();
      throw error;
    }
  }
}

/** Organisations de l'appelant, les plus récentes d'abord (sélecteur de contexte du portail). */
export class ListMyOrganizationsUseCase {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly pendingEmails: PendingEmails,
  ) {}

  async execute(userId: string): Promise<MembershipView[]> {
    const memberships = await this.organizations.memberships(userId);
    return Promise.all(memberships.map((membership) => view(membership, this.pendingEmails)));
  }
}

/** Fiche d'une organisation de l'appelant. */
export class GetMyOrganizationUseCase {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly pendingEmails: PendingEmails,
  ) {}

  async execute(userId: string, organizationId: string): Promise<MembershipView> {
    return view(await ownMembership(this.organizations, userId, organizationId), this.pendingEmails);
  }
}

/**
 * Déclarer ou changer l'e-mail de facturation : un code est envoyé à l'adresse, enregistrée
 * seulement à la confirmation (même règle que l'e-mail du profil, ADR-026). Une même adresse peut
 * servir à plusieurs organisations (un cabinet comptable, par exemple).
 */
export class ChangeOrganizationBillingEmailUseCase {
  private readonly issuer: EmailCodeIssuer;

  constructor(
    private readonly organizations: OrganizationRepository,
    verifications: EmailVerificationRepository,
    sender: EmailCodeSender,
    hasher: OtpHasher,
    codes: OtpCodeGenerator,
    ids: IdGenerator,
    clock: Clock,
    policy: OtpPolicy,
  ) {
    this.issuer = new EmailCodeIssuer(verifications, sender, hasher, codes, ids, clock, policy);
  }

  async execute(input: {
    userId: string;
    organizationId: string;
    email: string;
    ip: string | null;
  }): Promise<IssuedEmailCode> {
    const { organization } = await adminMembership(this.organizations, input.userId, input.organizationId);
    const email = EmailAddress.parse(input.email);
    if (!email) throw emailErrors.invalid();
    if (organization.billingEmail === email.value) throw emailErrors.alreadyVerified();
    return this.issuer.issue({
      userId: input.userId,
      email,
      ip: input.ip,
      organization: { id: organization.id, legalName: organization.legalName },
    });
  }
}

/** Confirmer l'e-mail de facturation par le dernier code reçu pour l'organisation. */
export class ConfirmOrganizationBillingEmailUseCase {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly verifications: EmailVerificationRepository,
    private readonly pendingEmails: PendingEmails,
    private readonly hasher: OtpHasher,
    private readonly clock: Clock,
    private readonly policy: OtpPolicy,
  ) {}

  async execute(input: { userId: string; organizationId: string; code: string }): Promise<MembershipView> {
    const { organization } = await adminMembership(this.organizations, input.userId, input.organizationId);
    const now = this.clock.now();
    const verification = await checkEmailCode(
      this.verifications,
      this.hasher,
      this.policy,
      await this.verifications.findLatestForOrganization(organization.id),
      input.code,
      now,
    );
    try {
      await this.verifications.confirmForOrganization({
        verificationId: verification.id,
        organizationId: organization.id,
        email: verification.target,
        now,
      });
    } catch (error) {
      if (error instanceof VerificationAlreadyConsumedError) throw emailErrors.expired();
      throw error;
    }
    return view(await ownMembership(this.organizations, input.userId, organization.id), this.pendingEmails);
  }
}
