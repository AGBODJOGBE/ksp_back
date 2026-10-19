import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import { type OtpChallengeRepository, type OtpRequestedEvent } from '../../application/otp/otp.ports';
import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type PhoneNumber } from '../../domain/user/phone-number';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaOtpChallengeRepository implements OtpChallengeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async sentAtSince(target: PhoneNumber, since: Date): Promise<Date[]> {
    const rows = await this.prisma.otpChallenge.findMany({
      where: { target: target.e164, sentAt: { gte: since } },
      select: { sentAt: true },
    });
    return rows.map((row) => row.sentAt as Date);
  }

  async create(challenge: OtpChallenge): Promise<void> {
    await this.prisma.otpChallenge.create({
      data: {
        id: challenge.id,
        target: challenge.target.e164,
        channel: challenge.channel,
        purpose: challenge.purpose,
        codeHash: challenge.codeHash,
        attempts: challenge.attempts,
        expiresAt: challenge.expiresAt,
        ip: challenge.ip,
        createdAt: challenge.createdAt,
      },
    });
  }

  async markSent(id: string, channelUsed: OtpChannel, sentAt: Date, event: OtpRequestedEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.otpChallenge.update({ where: { id }, data: { channelUsed, sentAt } });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope('identity.otp.requested', event, { producer: 'identity' }),
      );
    });
  }

  async markSendFailed(id: string, failedAt: Date): Promise<void> {
    await this.prisma.otpChallenge.update({ where: { id }, data: { sendFailedAt: failedAt } });
  }

  async findById(id: string): Promise<StoredOtpChallenge | null> {
    return this.prisma.otpChallenge.findUnique({
      where: { id },
      select: {
        id: true,
        target: true,
        codeHash: true,
        attempts: true,
        expiresAt: true,
        sentAt: true,
        sendFailedAt: true,
        consumedAt: true,
      },
    });
  }

  async registerFailedAttempt(id: string): Promise<number> {
    // Incrément fait par PostgreSQL : deux essais simultanés comptent bien pour deux.
    const updated = await this.prisma.otpChallenge.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }
}
