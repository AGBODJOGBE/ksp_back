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

/** Recherche de compte au back-office (ADR-029) : numéro E.164 dans le corps. */
export const accountBodies = {
  findAccountByPhone: z.strictObject({ phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/) }),
};

export const organizationParams = {
  status: z.enum(['pending_review', 'active', 'rejected', 'suspended']).optional(),
};
