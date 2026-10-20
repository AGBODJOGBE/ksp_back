import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type Account,
  type AccountRepository,
  ChallengeAlreadyConsumedError,
  type LoginRepository,
  PhoneAlreadyRegisteredError,
  type PhoneLoginPlan,
  type ProfileChanges,
} from '../../application/session/session.ports';
import { sessionsToRevoke } from '../../domain/session/session-policy';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';

export const ACCOUNT_SELECT = {
  id: true,
  status: true,
  firstName: true,
  lastName: true,
  preferredLanguage: true,
  createdAt: true,
  phones: { where: { isPrimary: true }, select: { phoneE164: true }, take: 1 },
} as const;

type AccountRow = Prisma.UserGetPayload<{ select: typeof ACCOUNT_SELECT }>;

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    status: row.status,
    firstName: row.firstName,
    lastName: row.lastName,
    phoneE164: row.phones[0]?.phoneE164 ?? null,
    // Les adresses e-mail arriveront avec UC-ID-02.
    email: null,
    preferredLanguage: row.preferredLanguage,
    createdAt: row.createdAt,
  };
}

/** Comptes et ouverture de session, en base identity. */
@Injectable()
export class PrismaLoginRepository implements AccountRepository, LoginRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByPhone(phoneE164: string): Promise<Account | null> {
    const phone = await this.prisma.userPhone.findUnique({
      where: { phoneE164 },
      select: { user: { select: ACCOUNT_SELECT } },
    });
    return phone ? toAccount(phone.user) : null;
  }

  async findById(userId: string): Promise<Account | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: ACCOUNT_SELECT });
    return user ? toAccount(user) : null;
  }

  async updateProfile(userId: string, changes: ProfileChanges): Promise<Account | null> {
    const updated = await this.prisma.user.updateMany({ where: { id: userId }, data: changes });
    return updated.count === 1 ? this.findById(userId) : null;
  }

  async completePhoneLogin(plan: PhoneLoginPlan): Promise<{ account: Account; isNewUser: boolean }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Consommation atomique : de deux validations simultanées, une seule passe.
        const consumed = await tx.otpChallenge.updateMany({
          where: { id: plan.challengeId, consumedAt: null },
          data: { consumedAt: plan.now },
        });
        if (consumed.count !== 1) throw new ChallengeAlreadyConsumedError();

        let userId = plan.existingUserId;
        const isNewUser = userId === null;
        if (isNewUser) {
          userId = plan.newUserId;
          await tx.user.create({
            data: {
              id: userId,
              status: 'active',
              createdAt: plan.now,
              phones: {
                create: {
                  id: plan.newPhoneId,
                  phoneE164: plan.phoneE164,
                  isPrimary: true,
                  verifiedAt: plan.now,
                },
              },
            },
          });
          await appendToOutbox(
            tx as unknown as SqlExecutor,
            createEnvelope(
              'identity.user.registered',
              { userId, method: 'phone' },
              { producer: 'identity', occurredAt: plan.now },
            ),
          );
        }

        const active = await tx.session.findMany({
          where: { userId: userId as string, revokedAt: null, expiresAt: { gt: plan.now } },
          select: { id: true, lastSeenAt: true },
        });
        const toRevoke = sessionsToRevoke(active, plan.maxSessions);
        if (toRevoke.length > 0) {
          await tx.session.updateMany({
            where: { id: { in: toRevoke } },
            data: { revokedAt: plan.now, revokeReason: 'session_limit' },
          });
        }

        await tx.session.create({
          data: {
            id: plan.session.id,
            userId: userId as string,
            clientKind: plan.session.clientKind,
            deviceLabel: plan.session.deviceLabel,
            userAgent: plan.session.userAgent,
            ip: plan.session.ip,
            createdAt: plan.now,
            lastSeenAt: plan.now,
            expiresAt: plan.session.expiresAt,
            refreshTokens: {
              create: { id: plan.refreshToken.id, tokenHash: plan.refreshToken.hash, issuedAt: plan.now },
            },
          },
        });
        await tx.loginEvent.create({
          data: {
            id: plan.loginEventId,
            userId,
            method: 'phone_otp',
            success: true,
            ip: plan.session.ip,
            userAgent: plan.session.userAgent,
            createdAt: plan.now,
          },
        });

        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId as string },
          select: ACCOUNT_SELECT,
        });
        return { account: toAccount(user), isNewUser };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        plan.existingUserId === null
      ) {
        throw new PhoneAlreadyRegisteredError();
      }
      throw error;
    }
  }

  async recordFailedLogin(event: {
    id: string;
    userId: string | null;
    reason: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await this.prisma.loginEvent.create({
      data: {
        id: event.id,
        userId: event.userId,
        method: 'phone_otp',
        success: false,
        failureReason: event.reason,
        ip: event.ip,
        userAgent: event.userAgent,
      },
    });
  }
}
