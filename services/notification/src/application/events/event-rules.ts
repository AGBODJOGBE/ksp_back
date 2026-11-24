import { type KspEventPayloads, type KspEventType } from '@ksp/contracts';

/** Un message à envoyer à un destinataire, déduit d'un événement. */
export interface NotificationIntent {
  /** Compte du destinataire ; ses coordonnées sont lues dans identity. */
  userId: string;
  templateCode: string;
  /** Variables du modèle, déjà mises en forme ; `first_name` est ajouté au moment de l'envoi. */
  variables: Record<string, string>;
  /** Lien vers l'espace KSP, repris par la notification dans l'application ; null s'il n'y en a pas. */
  link: string | null;
  /**
   * Organisation dont l'e-mail de facturation vérifié reçoit l'e-mail à la place de l'adresse du
   * destinataire (factures d'une entreprise). Sans e-mail de facturation, l'adresse vérifiée du
   * destinataire sert. WhatsApp et la notification dans l'espace restent pour le destinataire.
   * Quand la fiche est connue, sa raison sociale remplace la variable `organization_name`.
   */
  billingOrganizationId?: string;
  /**
   * Message adressé à l'organisation (factures, ADR-050) : `userId` est ignoré, ses administrateurs
   * actuels (annuaire identity) le reçoivent dans l'espace et par leurs canaux, jamais un ancien
   * membre. Avec un e-mail de facturation vérifié, l'e-mail part une seule fois à cette adresse, et
   * les administrateurs le reçoivent sans e-mail ; sinon chacun à son adresse vérifiée. Sa raison
   * sociale remplace `organization_name`. Organisation introuvable : personne n'est prévenu.
   */
  organizationId?: string;
  /**
   * Avec `organizationId` : `false` adresse le message aux administrateurs actuels seulement,
   * chacun par ses canaux et à sa propre adresse, sans copie à l'e-mail de facturation (messages du
   * Nettoyage : devis transmis pour accord, suspension). Par défaut : copie (factures, ADR-050).
   */
  billingEmailCopy?: boolean;
  /**
   * Message au personnel du Nettoyage (CDC Nettoyage v2, 16.2 ; RV-62) : `userId` est ignoré. Les
   * destinataires sont lus dans identity au moment de l'événement (ListStaffByPermission) ; personne :
   * repli configuré pour la permission, sinon l'équipe Nettoyage (`cleaningTeamUserIds`).
   */
  staff?: StaffAudience;
}

/** Personnel visé : la permission, et la clé de commune de la zone (null : attributions globales). */
export interface StaffAudience {
  permission: CleaningStaffPermission;
  zoneKey: string | null;
}

/**
 * Permissions qui désignent le personnel prévenu (RV-62) : traitement des demandes (superviseur),
 * gestion des programmes (séances, paiements, suspensions), réclamations, agents (admin).
 * Un admin Nettoyage porte ces permissions par une attribution globale : identity le rend aussi
 * pour une zone.
 */
export type CleaningStaffPermission =
  'cleaning.request.process' | 'cleaning.program.manage' | 'cleaning.claim.manage' | 'cleaning.agent.manage';

/** Réglages utiles à la rédaction des messages. */
export interface RuleContext {
  /** Adresse de « Mon espace KSP », sans barre finale. */
  portalBaseUrl: string;
  /** Fuseau des dates écrites dans les messages. */
  timeZone: string;
  /** Comptes de l'équipe Nettoyage prévenus quand l'événement ne désigne personne (peut être vide). */
  cleaningTeamUserIds: readonly string[];
  /** Comptes de l'équipe KSP qui valide les comptes entreprise (peut être vide). */
  accountsTeamUserIds: readonly string[];
  /**
   * Repli quand identity ne rend personne pour une permission (RV-62,
   * NOTIFICATION_CLEANING_STAFF_FALLBACK) : comptes prévenus, par permission.
   */
  cleaningStaffFallback?: Readonly<Partial<Record<CleaningStaffPermission, readonly string[]>>>;
  /** Adresse du back-office, sans barre finale, pour les liens du personnel ; absente : sans lien. */
  backOfficeBaseUrl?: string | null;
  /** Superviseurs du recouvrement, prévenus de chaque nouveau dossier à examiner (peut être vide). */
  recoverySupervisorUserIds: readonly string[];
  /** Juristes du recouvrement, prévenus des contestations et des actes des partenaires (peut être vide). */
  recoveryLegalUserIds: readonly string[];
}

export type EventRule<T extends KspEventType> = (
  payload: KspEventPayloads[T],
  context: RuleContext,
) => NotificationIntent[];

/**
 * Règles par événement écouté. Pour brancher un nouvel événement : écrire ses modèles dans
 * `domain/messages`, sa règle ici (fichier du métier), puis l'ajouter à `EVENT_RULES`.
 */
export type EventRules = { readonly [T in KspEventType]?: EventRule<T> };
