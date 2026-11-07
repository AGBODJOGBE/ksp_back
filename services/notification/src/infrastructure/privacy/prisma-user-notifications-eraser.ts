import { type SqlExecutor, SqlInboxStore, type TransactionalSqlClient } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type UserNotificationsErasure,
  type UserNotificationsEraser,
} from '../../application/privacy/erase-user-notifications.use-case';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Effacement des données d'un compte anonymisé (ADR-036), en une transaction avec l'inbox
 * (table processed_events du kit).
 */
@Injectable()
export class PrismaUserNotificationsEraser implements UserNotificationsEraser {
  private readonly store: SqlInboxStore;

  constructor(prisma: PrismaService) {
    this.store = new SqlInboxStore(prisma as unknown as TransactionalSqlClient);
  }

  async eraseUser(
    userId: string,
    inbox: { eventId: string; consumer: string },
  ): Promise<UserNotificationsErasure> {
    let inApp = 0;
    let deliveries = 0;
    const status = await this.store.runOnce(inbox.eventId, inbox.consumer, async (tx: SqlExecutor) => {
      inApp = await tx.$executeRawUnsafe('DELETE FROM in_app_notifications WHERE user_id = $1::uuid', userId);
      // Préférences de canaux (ADR-039) : sans objet pour un compte anonymisé.
      await tx.$executeRawUnsafe('DELETE FROM notification_preferences WHERE user_id = $1::uuid', userId);
      // La clé d'idempotence contient l'identifiant du compte : remplacée par une valeur unique sans
      // lien avec lui. Un événement rejoué ensuite ne renvoie rien (le compte n'a plus de coordonnées).
      deliveries = await tx.$executeRawUnsafe(
        "UPDATE notifications SET recipient_user_id = NULL, target_masked = '', " +
          "provider_message_id = NULL, idempotency_key = 'erased:' || id::text " +
          'WHERE recipient_user_id = $1::uuid',
        userId,
      );
      // Parenthèses obligatoires : `-` est prioritaire sur `->` en SQL.
      await tx.$executeRawUnsafe(
        "UPDATE outbox SET payload = jsonb_set(payload, '{payload}', " +
          "((payload->'payload') - 'recipientUserId'::text) || jsonb_build_object('targetMasked', ''::text)) " +
          "WHERE event_type = 'notification.message.failed' " +
          "AND lower(payload->'payload'->>'recipientUserId') = lower($1::text)",
        userId,
      );
    });
    return status === 'duplicate' ? { status, inApp: 0, deliveries: 0 } : { status, inApp, deliveries };
  }
}
