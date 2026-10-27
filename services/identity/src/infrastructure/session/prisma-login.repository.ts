import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type Account,
  type AccountRepository,
  ChallengeAlreadyConsumedError,
  type FailedLogin,
  type LoginRepository,
  PhoneAlreadyRegisteredError,
  type PhoneLoginPlan,
  type ProfileChanges,
} from '../../application/session/session.ports';
import { type UserDirectory } from '../../application/directory/get-users.use-case';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';
import { openSession } from './session-writes';

export const ACCOUNT_SELECT = {
  id: true,
  status: true,
  firstName: true,
  lastName: true,
  preferredLanguage: true,
  createdAt: true,
  email: true,
  emailVerifiedAt: true,
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
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt,
    preferredLanguage: row.preferredLanguage,
    createdAt: row.createdAt,
  };
}

/** Comptes et ouverture de session, en base identity. */
@Injectable()
export class PrismaLoginRepository implements AccountRepository, LoginRepository, UserDirectory {
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

  async findByIds(userIds: readonly string[]): Promise<Account[]> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: ACCOUNT_SELECT,
    });
    return users.map(toAccount);
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

        await openSession(tx, {
          userId: userId as string,
          session: plan.session,
          refreshToken: plan.refreshToken,
          loginEventId: plan.loginEventId,
          method: 'phone_otp',
          maxSessions: plan.maxSessions,
          mfaAt: null,
          now: plan.now,
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

  async recordFailedLogin(event: FailedLogin): Promise<void> {
    await this.prisma.loginEvent.create({
      data: {
        id: event.id,
        userId: event.userId,
        method: event.method ?? 'phone_otp',
        success: false,
        failureReason: event.reason,
        ip: event.ip,
        userAgent: event.userAgent,
      },
    });
  }
}
