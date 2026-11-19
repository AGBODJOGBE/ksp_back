import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type OtpChallengeRepository,
  type OtpRequestedEvent,
  type OtpReservation,
} from '../../application/otp/otp.ports';
import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { type SendDecision } from '../../domain/otp/otp-policy';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';
import { takeCodeAttempt } from './take-code-attempt';

async function createChallenge(tx: Prisma.TransactionClient, challenge: OtpChallenge): Promise<void> {
  await tx.otpChallenge.create({
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

@Injectable()
export class PrismaOtpChallengeRepository implements OtpChallengeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verrou transactionnel propre au numéro (pg_advisory_xact_lock, libéré au COMMIT ou au
   * ROLLBACK), puis lecture des envois comptés et insertion dans la même transaction. Le verrou est
   * pris en base, donc valable entre plusieurs répliques du service ; une collision de hachage entre
   * deux numéros ne fait que les sérialiser. En READ COMMITTED, la lecture faite après le verrou voit
   * les demandes validées par la transaction précédente.
   */
  async createIfAllowed(
    challenge: OtpChallenge,
    since: Date,
    decide: (recent: Date[]) => SendDecision,
  ): Promise<OtpReservation> {
    return this.prisma.$transaction(async (tx) => {
      // $executeRaw : la fonction renvoie void, que $queryRaw ne sait pas lire.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('otp_challenges'), hashtext(${challenge.target.e164}))`;
      const rows = await tx.$queryRaw<{ counted_at: Date }[]>`
        SELECT COALESCE("sent_at", "created_at") AS "counted_at" FROM "otp_challenges"
        WHERE "target" = ${challenge.target.e164} AND "send_failed_at" IS NULL
          AND COALESCE("sent_at", "created_at") >= ${since}`;
      const recent = rows.map((row) => row.counted_at);
      const decision = decide(recent);
      if (decision.allowed) await createChallenge(tx, challenge);
      return { decision, recent };
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

  takeAttempt(id: string, maxAttempts: number, now: Date): Promise<number | null> {
    return takeCodeAttempt(this.prisma, 'otp_challenges', { id, maxAttempts, now });
  }
}
