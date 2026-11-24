import { type UserStatusName } from '../session/session.ports';

/** Compte d'un numéro, tel qu'un service le reçoit : jamais le numéro ni le nom. */
export interface PhoneAccount {
  userId: string;
  status: UserStatusName;
}

/** Compte à créer pour un numéro, à la demande d'un service (EnsureUserByPhone). */
export interface NewPendingAccount {
  userId: string;
  phoneId: string;
  /** Numéro normalisé (ADR-063). */
  phoneE164: string;
  firstName: string;
  lastName: string;
  /** Trace d'audit : le service pour auteur, le membre du personnel à l'origine s'il est connu. */
  audit: { id: string; service: string; requestedBy: string | null };
  now: Date;
}

export interface PendingAccountRepository {
  /**
   * Crée le compte « en attente de vérification » (numéro principal non vérifié), l'événement
   * identity.user.registered et la trace d'audit, en une transaction. Un numéro n'appartient qu'à un
   * compte : si un autre appel a créé le compte de ce numéro entre-temps, c'est lui qui est rendu
   * (`created: false`), sans rien écrire.
   */
  createPending(account: NewPendingAccount): Promise<PhoneAccount & { created: boolean }>;
}
