import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type ClaimResult,
  type NewNotification,
  type NotificationFailedEvent,
  type NotificationRepository,
} from '../../application/send/notification.ports';
import { type ChannelName } from '../../domain/channel';
import { type FailureReason } from '../../domain/delivery';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claim(notification: NewNotification): Promise<ClaimResult> {
    // INSERT … ON CONFLICT DO NOTHING : de deux appels simultanés avec la même clé, un seul insère.
    const { count } = await this.prisma.notification.createMany({
      data: [{ ...notification, status: 'pending' }],
      skipDuplicates: true,
    });
    if (count === 1) return { created: true };

    const existing = await this.prisma.notification.findUniqueOrThrow({
      where: { idempotencyKey: notification.idempotencyKey },
      select: { id: true, status: true, channelUsed: true, channelsTried: true, errorCode: true },
    });
    return { created: false, existing };
  }

  async markAccepted(
    id: string,
    accepted: { channelUsed: ChannelName; channelsTried: ChannelName[]; providerMessageId: string; at: Date },
  ): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'accepted',
        channelUsed: accepted.channelUsed,
        channelsTried: accepted.channelsTried,
        providerMessageId: accepted.providerMessageId,
        acceptedAt: accepted.at,
      },
    });
  }

  async markFailed(
    id: string,
    failed: { channelsTried: ChannelName[]; reason: FailureReason; errorCode: string; at: Date },
    event: NotificationFailedEvent,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.notification.update({
        where: { id },
        data: {
          status: 'failed',
          channelsTried: failed.channelsTried,
          failureReason: failed.reason,
          errorCode: failed.errorCode,
          failedAt: failed.at,
        },
      });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope('notification.message.failed', event, { producer: 'notification' }),
      );
    });
  }
}
