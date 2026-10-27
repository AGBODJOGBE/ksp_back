/**
 * Événements publiés par identity (cahier des charges Identité, partie 8).
 * Source de vérité : contracts/events/identity/*.schema.json. Le test de contrat vérifie
 * que ces types et les schémas restent alignés.
 */
export type ScopeTypeName = 'global' | 'domain' | 'org' | 'personal';
export type OrgRole = 'org_admin' | 'org_member' | 'org_viewer';

export interface IdentityEventPayloads {
  'identity.user.registered': { userId: string; method: 'phone' | 'email' };
  /** Ne contient jamais le code de vérification (ADR-014). */
  'identity.otp.requested': {
    userId?: string | null;
    purpose: 'login' | 'phone_change' | 'mfa' | 'password_reset' | 'signature' | 'email_verification';
    channel: 'sms' | 'whatsapp' | 'email';
    targetMasked: string;
  };
  'identity.user.verified': { userId: string; verifiedVia: 'phone' | 'email' };
  'identity.user.suspended': { userId: string; reason: string; suspendedBy: string };
  'identity.user.reactivated': { userId: string; reactivatedBy: string };
  'identity.user.deleted': { userId: string };
  /** Demande de création, en attente de validation par un admin KSP (ADR-027). */
  'identity.organization.created': { organizationId: string; createdBy: string; legalName?: string };
  'identity.organization.validated': {
    organizationId: string;
    legalName: string;
    createdBy: string;
    validatedBy: string;
  };
  'identity.organization.rejected': {
    organizationId: string;
    legalName: string;
    createdBy: string;
    rejectedBy: string;
    reason: string;
  };
  /** `createdBy` : demandeur prévenu de la décision (absent des événements publiés avant son ajout). */
  'identity.organization.suspended': {
    organizationId: string;
    legalName: string;
    suspendedBy: string;
    createdBy?: string;
    reason: string;
  };
  'identity.organization.reactivated': {
    organizationId: string;
    legalName: string;
    reactivatedBy: string;
    createdBy?: string;
  };
  'identity.member.added': { organizationId: string; userId: string; orgRole: OrgRole };
  'identity.member.removed': { organizationId: string; userId: string; removedBy: string };
  'identity.role.granted': {
    assignmentId: string;
    userId: string;
    roleCode: string;
    scopeType: ScopeTypeName;
    scopeId?: string | null;
    grantedBy: string;
  };
  'identity.role.revoked': {
    assignmentId: string;
    userId: string;
    roleCode: string;
    revokedBy: string;
    reason?: string;
  };
}

export type IdentityEventType = keyof IdentityEventPayloads;
