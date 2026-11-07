/** Résultat de l'effacement des données d'un compte anonymisé. */
export interface UserNotificationsErasure {
  status: 'processed' | 'duplicate';
  /** Notifications de l'espace KSP supprimées. */
  inApp: number;
  /** Lignes de l'historique des envois détachées du compte. */
  deliveries: number;
}

/**
 * Effacement des données d'un compte anonymisé (ADR-036), dans la même transaction que la marque
 * « événement traité » de l'inbox : `duplicate` (et rien d'effacé) si l'événement l'est déjà.
 *
 * - notifications de l'espace KSP du compte : supprimées (titre et texte portent le prénom) ;
 * - préférences de canaux du compte (ADR-038) : supprimées ;
 * - historique des envois (`notifications`) : identifiant du compte, destinataire masqué, clé
 *   d'idempotence (elle contient l'identifiant du compte) et identifiant du message chez le
 *   prestataire retirés ; modèle, canaux, statut, cause d'échec et dates gardés pour les
 *   statistiques. Le texte et les variables d'un message ne sont jamais conservés (ADR-014) ;
 * - événements `notification.message.failed` gardés dans l'outbox : identifiant du compte et
 *   destinataire masqué retirés.
 */
export interface UserNotificationsEraser {
  eraseUser(userId: string, inbox: { eventId: string; consumer: string }): Promise<UserNotificationsErasure>;
}

/**
 * Compte anonymisé par identity (`identity.user.deleted`, ADR-036) : ses notifications de l'espace
 * KSP sont effacées et l'historique de ses envois est détaché. Idempotent (inbox).
 */
export class EraseUserNotificationsUseCase {
  constructor(private readonly eraser: UserNotificationsEraser) {}

  execute(input: { eventId: string; eventType: string; userId: string }): Promise<UserNotificationsErasure> {
    return this.eraser.eraseUser(input.userId.toLowerCase(), {
      eventId: input.eventId,
      consumer: `notification.${input.eventType}`,
    });
  }
}
