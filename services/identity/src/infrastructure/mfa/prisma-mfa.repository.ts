import { Injectable } from '@nestjs/common';
import {
  MfaChallengeAlreadyConsumedError,
  type MfaChallengeRepository,
  type MfaFactorRepository,
  type MfaLoginPlan,
  type MfaLoginRepository,
  type NewMfaChallenge,
  RecoveryCodeAlreadyUsedError,
  type SecondFactorProof,
  TotpAlreadyEnabledError,
  type TotpFactor,
  TotpStepAlreadyUsedError,
} from '../../application/mfa/mfa.ports';
import { type Account, ChallengeAlreadyConsumedError } from '../../application/session/session.ports';
import { type StoredMfaChallenge } from '../../domain/mfa/mfa-challenge';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_SELECT, toAccount } from '../session/prisma-login.repository';
import { openSession } from '../session/session-writes';

/** Étapes, facteurs et codes de récupération de la double authentification, en base identity. */
@Injectable()
export class PrismaMfaRepository implements MfaChallengeRepository, MfaFactorRepository, MfaLoginRepository {
  constructor(private readonly prisma: PrismaService) {}

  async openAfterOtp(otpChallengeId: string, challenge: NewMfaChallenge, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Consommation atomique du code par téléphone : de deux validations simultanées, une seule passe.
      const consumed = await tx.otpChallenge.updateMany({
        where: { id: otpChallengeId, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new ChallengeAlreadyConsumedError();
      await tx.mfaChallenge.create({ data: challenge });
    });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredMfaChallenge | null> {
    return this.prisma.mfaChallenge.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        clientKind: true,
        deviceLabel: true,
        attempts: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
  }

  async registerFailedAttempt(id: string): Promise<number> {
    const updated = await this.prisma.mfaChallenge.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  async findTotp(userId: string): Promise<TotpFactor | null> {
    return this.prisma.mfaFactor.findUnique({
      where: { userId_type: { userId, type: 'totp' } },
      select: { id: true, secretEncrypted: true, enabledAt: true, lastUsedStep: true },
    });
  }

  async savePendingTotp(input: {
    id: string;
    userId: string;
    secretEncrypted: string;
    now: Date;
  }): Promise<void> {
    try {
      await this.prisma.mfaFactor.create({
        data: {
          id: input.id,
          userId: input.userId,
          type: 'totp',
          secretEncrypted: input.secretEncrypted,
          createdAt: input.now,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      // Un secret existe déjà : il n'est remplacé que s'il n'a pas été confirmé.
      const replaced = await this.prisma.mfaFactor.updateMany({
        where: { userId: input.userId, type: 'totp', enabledAt: null },
        data: { secretEncrypted: input.secretEncrypted, createdAt: input.now, lastUsedStep: null },
      });
      if (replaced.count !== 1) throw new TotpAlreadyEnabledError();
    }
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  async findUnusedRecoveryCode(userId: string, codeHash: string): Promise<string | null> {
    const code = await this.prisma.mfaRecoveryCode.findFirst({
      where: { userId, codeHash, usedAt: null },
      select: { id: true },
    });
    return code?.id ?? null;
  }

  async completeMfaLogin(plan: MfaLoginPlan): Promise<{ account: Account; recoveryCodesRemaining: number }> {
    return this.prisma.$transaction(async (tx) => {
      const consumed = await tx.mfaChallenge.updateMany({
        where: { id: plan.mfaChallengeId, consumedAt: null, expiresAt: { gt: plan.now } },
        data: { consumedAt: plan.now },
      });
      if (consumed.count !== 1) throw new MfaChallengeAlreadyConsumedError();
      await applyProof(tx, plan.userId, plan.proof, plan.now);
      await openSession(tx, {
        userId: plan.userId,
        session: plan.session,
        refreshToken: plan.refreshToken,
        loginEventId: plan.loginEventId,
        method: plan.proof.kind === 'recovery_code' ? 'recovery_code' : 'totp',
        maxSessions: plan.maxSessions,
        mfaAt: plan.now,
        now: plan.now,
      });
      const user = await tx.user.findUniqueOrThrow({ where: { id: plan.userId }, select: ACCOUNT_SELECT });
      const recoveryCodesRemaining = await tx.mfaRecoveryCode.count({
        where: { userId: plan.userId, usedAt: null },
      });
      return { account: toAccount(user), recoveryCodesRemaining };
    });
  }
}

/** Applique la preuve de façon atomique ; une preuve déjà utilisée annule toute la transaction. */
async function applyProof(
  tx: Prisma.TransactionClient,
  userId: string,
  proof: SecondFactorProof,
  now: Date,
): Promise<void> {
  if (proof.kind === 'recovery_code') {
    const used = await tx.mfaRecoveryCode.updateMany({
      where: { id: proof.codeId, userId, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw new RecoveryCodeAlreadyUsedError();
    return;
  }
  if (proof.kind === 'totp') {
    // Le pas accepté doit être postérieur au dernier : un code rejoué, même en parallèle, est refusé.
    const accepted = await tx.mfaFactor.updateMany({
      where: {
        id: proof.factorId,
        userId,
        enabledAt: { not: null },
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: proof.step } }],
      },
      data: { lastUsedStep: proof.step, lastUsedAt: now },
    });
    if (accepted.count !== 1) throw new TotpStepAlreadyUsedError();
    return;
  }
  const enabled = await tx.mfaFactor.updateMany({
    where: { id: proof.factorId, userId, enabledAt: null },
    data: { enabledAt: now, lastUsedStep: proof.step, lastUsedAt: now },
  });
  if (enabled.count !== 1) throw new TotpAlreadyEnabledError();
  // De nouveaux codes remplacent ceux qui n'ont pas servi ; les codes utilisés restent pour l'historique.
  await tx.mfaRecoveryCode.deleteMany({ where: { userId, usedAt: null } });
  await tx.mfaRecoveryCode.createMany({
    data: proof.recoveryCodes.map((code) => ({ id: code.id, userId, codeHash: code.hash, createdAt: now })),
  });
}
