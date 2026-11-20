/*
 * Téléphones reçus en entrée : la règle commune à tous les services (ADR-063).
 * Module pur, sans aucune dépendance : le domaine des services l'importe par `@ksp/platform/phone`.
 */

const E164 = /^\+[1-9]\d{6,14}$/;
/** Ancien plan béninois : +229 suivi de 8 chiffres exactement. */
const BENIN_EIGHT_DIGITS = /^\+229\d{8}$/;
/** Forme à 10 chiffres issue d'un ancien numéro béninois : +229 01 suivi de 8 chiffres. */
const BENIN_FROM_EIGHT_DIGITS = /^\+22901\d{8}$/;

/**
 * Téléphone au format E.164, ou null si la valeur ne s'y ramène pas.
 * Espaces, points, tirets et parenthèses retirés, préfixe `00` lu comme `+` ; aucun indicatif n'est
 * deviné : un numéro sans indicatif est refusé.
 * Bénin (ADR-063, validé le 2026-11-20) : la numérotation est passée à 10 chiffres le 30/11/2024 en
 * ajoutant `01` devant les 8 chiffres, pour les mobiles comme pour les fixes ; un numéro `+229` à
 * 8 chiffres devient donc `+229 01` suivi des 8 chiffres, et les deux formes d'un même numéro
 * désignent la même personne. Un numéro à 10 chiffres n'est jamais retouché (règle idempotente). Les
 * autres pays sont inchangés.
 */
export function tryNormalizePhone(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  let phone = value.normalize('NFKC').replace(/[\s.\-()]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!E164.test(phone)) return null;
  return BENIN_EIGHT_DIGITS.test(phone) ? `+22901${phone.slice(4)}` : phone;
}

/**
 * Formes sous lesquelles un même numéro peut être enregistré, la forme normalisée en premier.
 * Pour un numéro béninois `+229 01` suivi de 8 chiffres, l'ancienne forme à 8 chiffres est ajoutée :
 * une ligne écrite avant la règle et pas encore réécrite reste retrouvée. Une valeur illisible n'a
 * qu'elle-même pour forme.
 */
export function phoneLookupForms(value: string): string[] {
  const normalized = tryNormalizePhone(value);
  if (normalized === null) return [value];
  return BENIN_FROM_EIGHT_DIGITS.test(normalized) ? [normalized, `+229${normalized.slice(6)}`] : [normalized];
}
