import { z } from 'zod';

/**
 * Briques zod des schémas produits depuis le contrat OpenAPI (cleaning-schemas.ts) : formats de
 * texte, paramètres de requête convertis, mots-clés JSON Schema sans équivalent direct en zod.
 */
export const uuid = z.guid();
export const dateTime = z.iso.datetime({ offset: true });
export const date = z.iso.date();

/** Paramètre numérique : texte de chiffres, converti en nombre puis validé. */
export const numberParam = (schema: z.ZodNumber) =>
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number)
    .pipe(schema);

/** Paramètre booléen : `true` ou `false`. */
export const booleanParam = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Éléments distincts (uniqueItems). */
export const unique = <T extends z.ZodArray<z.ZodType>>(schema: T) =>
  schema.superRefine((items, ctx) => {
    const seen = new Set(items.map((item) => JSON.stringify(item)));
    if (seen.size !== items.length) ctx.addIssue({ code: 'custom', message: 'Éléments en double.' });
  });

/** Champs qui vont ensemble (dependentRequired) : latitude et longitude… */
export const dependentRequired =
  (rules: Record<string, string[]>) => (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
    for (const [field, needed] of Object.entries(rules)) {
      if (value[field] === undefined) continue;
      for (const other of needed) {
        if (value[other] === undefined) {
          ctx.addIssue({ code: 'custom', path: [other], message: `Obligatoire avec ${field}.` });
        }
      }
    }
  };
