import { AppError } from '@ksp/platform';
import { z } from 'zod';

/**
 * Corps des requêtes, repris des schémas du contrat OpenAPI (components/schemas) : tout champ
 * inconnu est refusé. Un test vérifie que les champs et les champs obligatoires restent identiques.
 */
const mfaToken = z.string().min(1).max(128);

export const requestBodies = {
  requestOtp: z.strictObject({
    phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
    channel: z.enum(['sms', 'whatsapp']).optional(),
  }),
  verifyOtp: z.strictObject({
    challengeId: z.guid(),
    code: z.string().regex(/^[0-9]{4,8}$/),
    deviceLabel: z.string().max(100).optional(),
  }),
  enrollTotp: z.strictObject({ mfaToken }),
  confirmTotp: z.strictObject({ mfaToken, code: z.string().regex(/^[0-9]{6}$/) }),
  verifyMfa: z.strictObject({
    mfaToken,
    method: z.enum(['totp', 'recovery_code']),
    code: z.string().regex(/^[0-9A-Za-z -]{6,20}$/),
  }),
  refreshSession: z.strictObject({ refreshToken: z.string() }),
  logout: z.strictObject({ scope: z.enum(['this_device', 'all_devices']).optional() }),
  updateMe: z
    .strictObject({
      firstName: z.string().min(1).max(100).optional(),
      lastName: z.string().min(1).max(100).optional(),
      preferredLanguage: z
        .string()
        .regex(/^[a-z]{2}$/)
        .optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'Au moins un champ à modifier.' }),
};

/** Champ refusé et raison, sans reprendre la valeur envoyée (elle peut être un code ou un jeton). */
export interface FieldIssue {
  field: string;
  reason: string;
}

/** Valide un corps de requête ; refus : 400 GATEWAY_VALIDATION_FAILED avec la liste des champs en cause. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fields: FieldIssue[] = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ field: [...issue.path, key].join('.'), reason: 'unknown_field' }))
      : [{ field: issue.path.join('.') || '(corps)', reason: issue.code }],
  );
  throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'La requête est invalide.', { fields });
}

/** Corps facultatif : absent ou objet vide. */
export function isEmptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)
  );
}
