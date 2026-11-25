import { addDays, localDay, localInstant, type LocalDay } from './calendar';
import { type ContactWindow, isWithinContactWindow, nextContactInstant } from './contact-policy';
import { BASIS_POINTS, isWholeAmount } from './money';
import { type Outcome, refusal, success } from './outcome';
import { type AmicableAction } from './progression';

/**
 * Procédure amiable (partie 5, étapes 1 à 3 ; partie 7 ; R-PR-05) : moment d'un message automatique
 * au débiteur, canal choisi, remise pour paiement immédiat. Les délais d'étape, la séquence de relance
 * et les échéanciers sont dans `progression`, `deadlines` et `payment-plan`.
 */

/** Canal d'un message au débiteur : WhatsApp au téléphone, ou e-mail. */
export type MessageChannel = 'whatsapp' | 'email';

/**
 * Un message automatique part dans la plage de contact et jamais un jour férié du Bénin (ADR-060,
 * point 16 : le samedi reste un jour de contact, sans être un jour ouvré).
 */
export function isAutomaticMessageAllowed(
  instant: Date,
  window: ContactWindow,
  holidays: ReadonlySet<LocalDay>,
): boolean {
  return isWithinContactWindow(instant, window) && !holidays.has(localDay(instant));
}

/** Premier instant permis à un message automatique à partir de `instant` (lui-même s'il l'est). */
export function nextAutomaticMessageInstant(
  instant: Date,
  window: ContactWindow,
  holidays: ReadonlySet<LocalDay>,
): Date {
  let candidate = nextContactInstant(instant, window);
  // Une année de jours fériés d'affilée n'existe pas : la borne évite seulement une boucle infinie.
  for (let attempt = 0; attempt < 366 && holidays.has(localDay(candidate)); attempt += 1) {
    candidate = nextContactInstant(localInstant(addDays(localDay(candidate), 1), 0), window);
  }
  return candidate;
}

/**
 * Canal d'un message automatique : le premier de l'ordre réglé dont la coordonnée est connue. L'ordre
 * est un réglage du service (la place de WhatsApp au premier contact reste à trancher avec l'avocat).
 */
export function pickChannel(
  order: readonly MessageChannel[],
  available: { phone: boolean; email: boolean },
): MessageChannel | null {
  return order.find((channel) => (channel === 'whatsapp' ? available.phone : available.email)) ?? null;
}

/**
 * Ce que devient une action de la séquence de relance amiable : le message part seul (lien renouvelé) ;
 * le courrier ou l'e-mail part seul par e-mail si le débiteur en a un, sinon le chargé envoie un
 * courrier ; l'appel et la visite restent au chargé (« Ma journée »).
 */
export function automaticChannelOf(action: AmicableAction, hasEmail: boolean): 'any' | 'email' | null {
  if (action === 'message') return 'any';
  if (action === 'letter_or_email') return hasEmail ? 'email' : null;
  return null;
}

/** Remise pour paiement immédiat (R-PR-05 ; message `Settlement` du contrat). */
export interface SettlementTerms {
  payNow: number;
  waived: number;
  /** Remise en points de base du montant dû, arrondie au point supérieur. */
  discountBps: number;
  /** Dans le barème du créancier : le chargé la propose seul ; au-delà, le créancier décide. */
  withinScale: boolean;
}

/**
 * Remise proposée : payer `payNow` tout de suite contre l'abandon du reste. Le montant à payer est
 * entier, positif et inférieur au dû ; la remise est dans le barème si elle n'excède pas la remise
 * maximale du créancier (0 : toute remise lui est soumise).
 */
export function settlementTerms(
  due: number,
  payNow: number,
  maxDiscountBps: number,
): Outcome<SettlementTerms> {
  if (!isWholeAmount(payNow) || payNow === 0 || payNow >= due) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Montant à payer entier, positif et inférieur au montant dû');
  }
  const waived = due - payNow;
  return success({
    payNow,
    waived,
    discountBps: Math.ceil((waived * BASIS_POINTS) / due),
    withinScale: waived * BASIS_POINTS <= due * maxDiscountBps,
  });
}
