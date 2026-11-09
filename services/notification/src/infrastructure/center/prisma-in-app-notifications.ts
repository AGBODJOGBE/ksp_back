import { Injectable } from '@nestjs/common';
import {
  type InAppNotificationStore,
  type PageRequest,
  type PageResult,
  type StoredInAppNotification,
} from '../../application/center/center.ports';
import { PrismaService } from '../prisma/prisma.service';

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * Notifications de l'espace KSP (table in_app_notifications). Chaque requête porte l'identifiant
 * du compte : une notification d'un autre compte n'est ni lue ni modifiée.
 */
@Injectable()
export class PrismaInAppNotifications implements InAppNotificationStore {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    page: PageRequest,
    filter: { unreadOnly: boolean },
  ): Promise<PageResult<StoredInAppNotification>> {
    const base = { userId, ...(filter.unreadOnly ? { readAt: null } : {}) };
    let after = {};
    if (page.cursor) {
      const cursor = await this.prisma.inAppNotification.findFirst({
        where: { id: page.cursor, userId },
        select: { id: true, createdAt: true },
      });
      // Curseur inconnu ou d'un autre compte : rien après lui.
      if (!cursor) return { items: [], nextCursor: null };
      after = {
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      };
    }
    const rows = await this.prisma.inAppNotification.findMany({
      where: { ...base, ...after },
      orderBy: NEWEST_FIRST,
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(toStored);
    return { items, nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  countUnread(userId: string): Promise<number> {
    return this.prisma.inAppNotification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string, at: Date): Promise<StoredInAppNotification | null> {
    // Condition sur read_at : deux appels simultanés gardent la première date de lecture.
    await this.prisma.inAppNotification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: at },
    });
    const row = await this.prisma.inAppNotification.findFirst({ where: { id, userId } });
    return row ? toStored(row) : null;
  }

  async markAllRead(userId: string, at: Date): Promise<number> {
    const { count } = await this.prisma.inAppNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: at },
    });
    return count;
  }
}

function toStored(row: {
  id: string;
  userId: string;
  templateCode: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
}): StoredInAppNotification {
  return {
    id: row.id,
    userId: row.userId,
    templateCode: row.templateCode,
    title: row.title,
    body: row.body,
    link: row.link,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}
