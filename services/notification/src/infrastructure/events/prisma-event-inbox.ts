import { type SqlExecutor, SqlInboxStore, type TransactionalSqlClient } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import { type EventInbox, type InAppNotification } from '../../application/events/event-notification.ports';
import { PrismaService } from '../prisma/prisma.service';

/** Nom du consommateur dans la table processed_events (inbox du kit). */
export const INBOX_CONSUMER = 'notification';

/**
 * Inbox de notification (kit platform, table processed_events) et notifications dans l'espace,
 * écrites dans la même transaction que la marque « événement traité ».
 */
@Injectable()
export class PrismaEventInbox implements EventInbox {
  private readonly store: SqlInboxStore;

  constructor(private readonly prisma: PrismaService) {
    this.store = new SqlInboxStore(prisma as unknown as TransactionalSqlClient);
  }

  async isProcessed(eventId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM processed_events WHERE event_id = $1::uuid AND consumer = $2',
      eventId,
      INBOX_CONSUMER,
    );
    return rows.length > 0;
  }

  complete(eventId: string, inApp: readonly InAppNotification[]): Promise<'processed' | 'duplicate'> {
    return this.store.runOnce(eventId, INBOX_CONSUMER, async (tx: SqlExecutor) => {
      for (const notification of inApp) {
        await tx.$executeRawUnsafe(
          'INSERT INTO in_app_notifications ' +
            '(id, user_id, template_code, title, body, link, source_event_id, created_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8) ' +
            'ON CONFLICT (source_event_id, user_id, template_code) DO NOTHING',
          notification.id,
          notification.userId,
          notification.templateCode,
          notification.title,
          notification.body,
          notification.link,
          notification.sourceEventId,
          notification.createdAt,
        );
      }
    });
  }
}
