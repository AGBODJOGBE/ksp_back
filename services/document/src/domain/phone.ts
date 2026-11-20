import { tryNormalizePhone } from '@ksp/platform/phone';

/**
 * Numéro E.164 sans espace, ou null s'il est mal formé. Normalisation commune du kit (ADR-063) : un
 * numéro béninois `+229` à 8 chiffres devient `+229 01` suivi des 8 chiffres.
 */
export function parsePhone(value: string | null | undefined): string | null {
  return tryNormalizePhone(value);
}

/**
 * Forme masquée, seule montrée et journalisée : indicatif et deux derniers chiffres, par exemple
 * +229********45 (même forme que notification et identity).
 */
export function maskPhone(e164: string): string {
  const digits = e164.slice(1);
  return `+${digits.slice(0, 3)}${'*'.repeat(Math.max(digits.length - 5, 0))}${digits.slice(-2)}`;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

/** Adresse e-mail plausible (minuscules, sans espace), ou null. */
export function parseEmail(value: string | null | undefined): string | null {
  const compact = (value ?? '').trim().toLowerCase();
  return compact.length <= 254 && EMAIL.test(compact) ? compact : null;
}
