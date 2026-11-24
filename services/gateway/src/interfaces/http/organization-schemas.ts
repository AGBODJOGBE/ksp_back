import { z } from 'zod';

/**
 * Corps et paramètres des routes des comptes entreprise, repris du contrat OpenAPI : tout champ
 * inconnu est refusé. Les règles métier (format de l'IFU et du RCCM, adresse e-mail, motif) restent
 * dans identity.
 */
const reason = z.strictObject({ reason: z.string().min(1).max(500) });

export const organizationBodies = {
  switchContext: z.strictObject({ organizationId: z.guid().nullable() }),
  createOrganization: z.strictObject({
    legalName: z.string().min(1).max(200),
    address: z.string().min(1).max(300),
    ifu: z.string().min(1).max(30),
    rccm: z.string().min(1).max(50).optional(),
  }),
  changeOrganizationBillingEmail: z.strictObject({ email: z.string().min(3).max(254) }),
  confirmOrganizationBillingEmail: z.strictObject({ code: z.string().regex(/^[0-9]{4,8}$/) }),
  rejectOrganization: reason,
  suspendOrganization: reason,
};

const ZONE_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PERMISSION_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const ROLE_CODE = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const unique = (values: string[]) => new Set(values).size === values.length;
const permissionList = z
  .array(z.string().regex(PERMISSION_CODE))
  .max(500)
  .refine(unique, { message: 'doublon' });

/** Paramètres des routes des rôles : code du rôle, filtre des permissions. */
export const roleParams = {
  code: ROLE_CODE,
  listPermissions: z.strictObject({
    service: z
      .string()
      .regex(/^[a-z]+$/)
      .optional(),
    includeRetired: z.enum(['true', 'false']).optional(),
  }),
};

/** Motif d'une action de l'administration des comptes (ADR-043), tracé par identity. */
const adminReason = z.strictObject({ reason: z.string().min(1).max(500) });

/**
 * Comptes au back-office : recherche par numéro (ADR-029), administration des comptes et des rôles
 * (ADR-043). Le périmètre de l'appelant et la forme du motif restent contrôlés par identity.
 */
export const accountBodies = {
  findAccountByPhone: z.strictObject({ phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/) }),
  searchAccounts: z.strictObject({
    query: z.string().max(100).optional(),
    limit: z.int().min(1).max(50).optional(),
    cursor: z.guid().optional(),
  }),
  grantAccountRole: z.strictObject({
    roleCode: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    reason: z.string().min(1).max(500),
    // Facultatif : attribution limitée à ces communes (R-RB-03).
    zoneKeys: z
      .array(z.string().regex(ZONE_KEY))
      .min(1)
      .max(77)
      .refine(unique, { message: 'doublon' })
      .optional(),
  }),
  // Rôles dynamiques du super administrateur (R-RB-02, ADR-057).
  createRole: z.strictObject({
    code: ROLE_CODE,
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    permissions: permissionList,
    sensitive: z.boolean().optional(),
    reason: z.string().min(1).max(500),
  }),
  updateRole: z.strictObject({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    sensitive: z.boolean().optional(),
    permissions: permissionList.optional(),
    reason: z.string().min(1).max(500),
  }),
  deactivateRole: adminReason,
  revokeAccountRole: z.strictObject({ assignmentId: z.guid(), reason: z.string().min(1).max(500) }),
  suspendAccount: adminReason,
  reactivateAccount: adminReason,
  resetAccountMfa: adminReason,
};

export const organizationParams = {
  status: z.enum(['pending_review', 'active', 'rejected', 'suspended']).optional(),
};
