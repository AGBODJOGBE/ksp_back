import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  EmailAlreadyUsedError,
  type EmailCodeRequestedEvent,
  type EmailConfirmation,
  type EmailVerificationRepository,
  type NewEmailVerification,
  type StoredEmailVerification,
  VerificationAlreadyConsumedError,
} from '../../application/email/email.ports';
import { type Account } from '../../application/session/session.ports';
import { type EmailAddress } from '../../domain/user/email-address';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_SELECT, toAccount } from '../session/prisma-login.repository';

/** Demandes de confirmation de l'e-mail du profil, en base identity (table email_verifications). */
@Injectable()
export class PrismaEmailVerificationRepository implements EmailVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async sentAtForEmailSince(email: EmailAddress, since: Date): Promise<Date[]> {
    return this.sentSince({ email: email.value }, since);
  }

  async sentAtForUserSince(userId: string, since: Date): Promise<Date[]> {
    return this.sentSince({ userId }, since);
  }

  async create(verification: NewEmailVerification): Promise<void> {
    await this.prisma.emailVerification.create({
      data: {
        id: verification.id,
        userId: verification.userId,
        email: verification.email.value,
        codeHash: verification.codeHash,
        expiresAt: verification.expiresAt,
        ip: verification.ip,
        createdAt: verification.createdAt,
      },
    });
  }

  async markSent(id: string, sentAt: Date, event: EmailCodeRequestedEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.emailVerification.update({ where: { id }, data: { sentAt } });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope('identity.otp.requested', event, { producer: 'identity' }),
      );
    });
  }

  async markSendFailed(id: string, failedAt: Date): Promise<void> {
    await this.prisma.emailVerification.update({ where: { id }, data: { sendFailedAt: failedAt } });
  }

  async findLatest(userId: string): Promise<StoredEmailVerification | null> {
    // Identifiants UUID v7 : l'ordre des identifiants départage deux demandes de la même milliseconde.
    const row = await this.prisma.emailVerification.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        userId: true,
        email: true,
        codeHash: true,
        attempts: true,
        expiresAt: true,
        sentAt: true,
        sendFailedAt: true,
        consumedAt: true,
      },
    });
    if (!row) return null;
    const { email, ...rest } = row;
    return { ...rest, target: email };
  }

  async registerFailedAttempt(id: string): Promise<number> {
    // Incrément fait par PostgreSQL : deux essais simultanés comptent bien pour deux.
    const updated = await this.prisma.emailVerification.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  async confirm(confirmation: EmailConfirmation): Promise<Account> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Consommation atomique : de deux confirmations simultanées, une seule passe.
        const consumed = await tx.emailVerification.updateMany({
          where: { id: confirmation.verificationId, userId: confirmation.userId, consumedAt: null },
          data: { consumedAt: confirmation.now },
        });
        if (consumed.count !== 1) throw new VerificationAlreadyConsumedError();

        // Index unique users_email_key : une adresse confirmée n'appartient qu'à un compte.
        const user = await tx.user.update({
          where: { id: confirmation.userId },
          data: { email: confirmation.email, emailVerifiedAt: confirmation.now },
          select: ACCOUNT_SELECT,
        });
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope(
            'identity.user.verified',
            { userId: confirmation.userId, verifiedVia: 'email' },
            { producer: 'identity', occurredAt: confirmation.now },
          ),
        );
        return toAccount(user);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new EmailAlreadyUsedError();
      }
      throw error;
    }
  }

  private async sentSince(where: { email: string } | { userId: string }, since: Date): Promise<Date[]> {
    const rows = await this.prisma.emailVerification.findMany({
      where: { ...where, sentAt: { gte: since } },
      select: { sentAt: true },
    });
    return rows.map((row) => row.sentAt as Date);
  }
}
