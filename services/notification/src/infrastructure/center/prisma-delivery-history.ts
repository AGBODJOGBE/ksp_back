import { Injectable } from '@nestjs/common';
import {
  type DeliveryFilters,
  type DeliveryHistory,
  type DeliveryRecord,
  type PageRequest,
  type PageResult,
} from '../../application/center/center.ports';
import { type ChannelName } from '../../domain/channel';
import { type NotificationStatus } from '../../domain/delivery';
import { PrismaService } from '../prisma/prisma.service';

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** Colonnes lues : jamais la clé d'idempotence (elle contient l'identifiant du compte). */
const SELECT = {
  id: true,
  idempotencyKey: true,
  templateCode: true,
  requestedChannel: true,
  channelUsed: true,
  channelsTried: true,
  targetMasked: true,
  recipientUserId: true,
  status: true,
  errorCode: true,
  failureReason: true,
  providerMessageId: true,
  createdAt: true,
  expiresAt: true,
  acceptedAt: true,
  failedAt: true,
} as const;

/** Historique des envois (table notifications), en lecture seule pour le back-office (ADR-039). */
@Injectable()
export class PrismaDeliveryHistory implements DeliveryHistory {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: DeliveryFilters, page: PageRequest): Promise<PageResult<DeliveryRecord>> {
    const where = {
      ...(filters.templateCode ? { templateCode: filters.templateCode } : {}),
      ...(filters.channel ? { channelsTried: { has: filters.channel } } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.recipientUserId ? { recipientUserId: filters.recipientUserId } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lt: filters.to } : {}),
            },
          }
        : {}),
    };
    let after = {};
    if (page.cursor) {
      const cursor = await this.prisma.notification.findUnique({
        where: { id: page.cursor },
        select: { id: true, createdAt: true },
      });
      if (!cursor) return { items: [], nextCursor: null };
      after = {
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      };
    }
    const rows = await this.prisma.notification.findMany({
      where: { AND: [where, after] },
      orderBy: NEWEST_FIRST,
      take: page.limit + 1,
      select: SELECT,
    });
    const items = rows.slice(0, page.limit).map(toRecord);
    return { items, nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async find(id: string): Promise<DeliveryRecord | null> {
    const row = await this.prisma.notification.findUnique({ where: { id }, select: SELECT });
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: {
  id: string;
  idempotencyKey: string;
  templateCode: string;
  requestedChannel: string;
  channelUsed: string | null;
  channelsTried: string[];
  targetMasked: string;
  recipientUserId: string | null;
  status: string;
  errorCode: string | null;
  failureReason: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  failedAt: Date | null;
}): DeliveryRecord {
  return {
    id: row.id,
    templateCode: row.templateCode,
    requestedChannel: row.requestedChannel as ChannelName,
    channelUsed: row.channelUsed as ChannelName | null,
    channelsTried: row.channelsTried as ChannelName[],
    targetMasked: row.targetMasked,
    recipientUserId: row.recipientUserId,
    status: row.status as NotificationStatus,
    errorCode: row.errorCode,
    failureReason: row.failureReason,
    providerMessageId: row.providerMessageId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    failedAt: row.failedAt,
    erased: row.idempotencyKey.startsWith('erased:'),
  };
}
