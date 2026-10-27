/** Coordonnées d'un destinataire, lues dans identity au moment de l'événement. */
export interface RecipientContact {
  userId: string;
  firstName: string | null;
  phoneE164: string | null;
  /** Adresse e-mail vérifiée par code ; null si le compte n'en a pas (aucun e-mail n'est alors envoyé). */
  email: string | null;
  /** Langue préférée (deux lettres). Les messages n'existent qu'en français au lot 2. */
  language: string;
}

/**
 * Annuaire des destinataires (identity, GetUsersByIds). Un compte introuvable ou supprimé est
 * simplement absent du résultat ; une panne lève une erreur (l'événement sera repris plus tard).
 */
export interface RecipientDirectory {
  findContacts(userIds: readonly string[]): Promise<RecipientContact[]>;
}

/**
 * Coordonnées de facturation d'une organisation (compte entreprise), lues dans identity au moment
 * de l'événement.
 */
export interface OrganizationBillingContact {
  organizationId: string;
  /** Raison sociale, reprise dans l'objet des e-mails de facture. */
  legalName: string;
  /** Adresse vérifiée par code ; null si l'organisation n'en a pas confirmé. */
  billingEmail: string | null;
}

/**
 * Fiches des organisations (identity, GetOrganizationsByIds). Une organisation introuvable est
 * simplement absente du résultat ; une panne lève une erreur (l'événement sera repris plus tard).
 */
export interface OrganizationDirectory {
  findBillingContacts(organizationIds: readonly string[]): Promise<OrganizationBillingContact[]>;
}

/** Notification « dans l'application » : affichée dans l'espace KSP du destinataire. */
export interface InAppNotification {
  id: string;
  userId: string;
  templateCode: string;
  title: string;
  body: string;
  /** Lien vers la page concernée de l'espace KSP ; null s'il n'y en a pas. */
  link: string | null;
  /** Événement à l'origine de la notification. */
  sourceEventId: string;
  createdAt: Date;
}

/**
 * Inbox du service (règle d'or n° 4) : un événement reçu deux fois n'a qu'un effet.
 * `complete` marque l'événement traité et enregistre ses notifications dans l'espace, dans la
 * même transaction ; `duplicate` si un autre traitement l'a déjà marqué.
 */
export interface EventInbox {
  isProcessed(eventId: string): Promise<boolean>;
  complete(eventId: string, inApp: readonly InAppNotification[]): Promise<'processed' | 'duplicate'>;
}
