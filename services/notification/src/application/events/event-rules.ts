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
}

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
