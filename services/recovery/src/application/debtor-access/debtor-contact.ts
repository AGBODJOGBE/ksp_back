import { tryNormalizePhone } from '@ksp/platform';
import { type PersonalData } from '../ports';
import { type EncryptedContact } from './debtor-access.ports';

/** Contexte de chiffrement des coordonnées des débiteurs (colonne `debtor_contacts.value_enc`, ADR-063). */
export const DEBTOR_CONTACT_CONTEXT = 'debtor_contacts.value';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

/**
 * Destinataire du code d'accès (ADR-061) : le téléphone du débiteur, par WhatsApp ; l'e-mail du
 * dossier seulement pour un débiteur sans téléphone. Une seule coordonnée est transmise : un débiteur
 * qui a un téléphone ne reçoit jamais son code par e-mail, là où son lien a pu arriver.
 */
export interface CodeRecipient {
  channel: 'whatsapp' | 'email';
  phone: string | null;
  email: string | null;
  /** Forme masquée, seule montrée au détenteur du lien avant le code. */
  masked: string;
}

/**
 * Parmi les coordonnées valables du débiteur (dans l'ordre du port de lecture) : le premier téléphone
 * lisible, sinon le premier e-mail ; null si aucune ne permet d'envoyer le code.
 */
export function codeRecipient(
  contacts: readonly EncryptedContact[],
  personalData: PersonalData,
): CodeRecipient | null {
  for (const contact of contacts.filter((candidate) => candidate.channel === 'phone')) {
    const phone = tryNormalizePhone(personalData.decrypt(contact.valueEnc, DEBTOR_CONTACT_CONTEXT));
    if (phone) return { channel: 'whatsapp', phone, email: null, masked: maskPhone(phone) };
  }
  for (const contact of contacts.filter((candidate) => candidate.channel === 'email')) {
    const email = personalData.decrypt(contact.valueEnc, DEBTOR_CONTACT_CONTEXT).trim().toLowerCase();
    if (EMAIL.test(email)) return { channel: 'email', phone: null, email, masked: maskEmail(email) };
  }
  return null;
}

/**
 * Téléphone masqué : « +229 01 ** ** ** 45 » pour un numéro du Bénin (forme du contrat), sinon les
 * trois premiers chiffres et les deux derniers (« +336******78 », forme de notification et d'identity).
 */
export function maskPhone(e164: string): string {
  const benin = /^\+229(\d{2})\d{6}(\d{2})$/.exec(e164);
  if (benin) return `+229 ${benin[1]} ** ** ** ${benin[2]}`;
  const digits = e164.slice(1);
  return `+${digits.slice(0, 3)}${'*'.repeat(Math.max(digits.length - 5, 0))}${digits.slice(-2)}`;
}

/** Adresse masquée : première lettre et domaine, « d***@exemple.com » (forme de notification). */
export function maskEmail(email: string): string {
  return `${email.slice(0, 1)}***${email.slice(email.lastIndexOf('@'))}`;
}
