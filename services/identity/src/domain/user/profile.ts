/**
 * Règles du profil (UC-ID-01 : le nom se complète après l'inscription par téléphone).
 * Un nom accepte les lettres de toutes les langues, les espaces, le trait d'union, l'apostrophe
 * et le point : « Jean-Baptiste », « N'Diaye », « Koffi A. ». Ni chiffres ni symboles.
 */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const LANGUAGE = /^[a-z]{2}$/;
export const NAME_MAX_LENGTH = 100;

/** Nom nettoyé (espaces en trop retirés), ou null s'il n'est pas acceptable. */
export function normalizeName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > NAME_MAX_LENGTH || !NAME.test(name)) return null;
  return name;
}

/** Code de langue ISO 639-1 en minuscules (« fr », « en »), ou null. */
export function normalizeLanguage(value: string): string | null {
  const code = value.trim().toLowerCase();
  return LANGUAGE.test(code) ? code : null;
}

/** Le nom complet est obligatoire avant tout paiement ou dépôt de dossier (cahier des charges, partie 4). */
export function isProfileIncomplete(profile: { firstName: string | null; lastName: string | null }): boolean {
  return !profile.firstName || !profile.lastName;
}
