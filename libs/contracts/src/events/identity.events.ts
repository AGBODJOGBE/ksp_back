/**
 * Événements publiés par identity (cahier des charges Identité, partie 8).
 * Source de vérité : contracts/events/identity/*.schema.json. Le test de contrat vérifie
 * que ces types et les schémas restent alignés.
 */
/**
 * `zone` : attribution limitée à des communes (R-RB-03 du CDC Nettoyage v2), dans
 * identity.role.granted version 2 seulement.
 */
export type ScopeTypeName = 'global' | 'domain' | 'org' | 'personal' | 'zone';
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
  /** Anonymisé à l'échéance du délai de suppression (UC-ID-11, ADR-036). */
  'identity.user.deleted': { userId: string };
  /** Suppression demandée : compte gelé jusqu'à `scheduledFor` (ADR-036). */
  'identity.user.deletion_requested': { userId: string; requestedAt: string; scheduledFor: string };
  /** Suppression annulée pendant le délai : compte de nouveau actif (ADR-036). */
  'identity.user.deletion_cancelled': { userId: string };
  /**
   * Double authentification réinitialisée au back-office (ADR-050) : le titulaire est prévenu, et
   * doit la reconfigurer avant `enrollBefore`.
   */
  'identity.user.mfa_reset': { userId: string; enrollBefore: string };
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
  /**
   * Versions 1 et 2 (contracts/events/identity/identity.role.granted.v1 et .v2) : la v2 ajoute la
   * portée `zone` et `zoneKeys` ; tout message v1 est un message v2 valide. Publié en version 2
   * (enveloppe `version: 2`) dès qu'une attribution peut porter des zones ; un consommateur déclare
   * `versions: [1, 2]`.
   */
  'identity.role.granted': {
    assignmentId: string;
    userId: string;
    roleCode: string;
    scopeType: ScopeTypeName;
    scopeId?: string | null;
    /** v2, portée zone : clés des communes (référentiel de geo) ; absent sinon. */
    zoneKeys?: string[];
    grantedBy: string;
  };
  'identity.role.revoked': {
    assignmentId: string;
    userId: string;
    roleCode: string;
    revokedBy: string;
    reason?: string;
    /** Rôle sensible (R-RB-05) : toutes les sessions de la personne révoquées immédiatement. */
    sessionsRevoked?: boolean;
  };
  /** Rôle créé au back-office par le super administrateur (R-RB-02). */
  'identity.role.created': {
    roleCode: string;
    name: string;
    permissions: string[];
    sensitive: boolean;
    createdBy: string;
  };
  /** Rôle modifié : l'avant et l'après des permissions (R-RB-06). */
  'identity.role.updated': {
    roleCode: string;
    name?: string;
    sensitive?: boolean;
    permissionsAdded: string[];
    permissionsRemoved: string[];
    updatedBy: string;
  };
  /** Rôle désactivé, sans attribution active (R-RB-02). */
  'identity.role.deactivated': { roleCode: string; deactivatedBy: string; reason: string };
  /** Rôle d'un membre changé dans son organisation (R-CP-03). */
  'identity.member.role_changed': {
    organizationId: string;
    userId: string;
    previousOrgRole: OrgRole;
    orgRole: OrgRole;
    changedBy: string;
  };
  /** Invitation d'un compte existant dans une organisation (R-CP-03) ; jamais de numéro. */
  'identity.member.invited': {
    invitationId: string;
    organizationId: string;
    inviteeUserId: string;
    orgRole: OrgRole;
    invitedBy: string;
    expiresAt: string;
  };
}

export type IdentityEventType = keyof IdentityEventPayloads;
