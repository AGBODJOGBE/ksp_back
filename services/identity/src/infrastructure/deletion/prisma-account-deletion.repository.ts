import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type AccountDeletionRepository,
  type DeletionRequestPlan,
} from '../../application/deletion/account-deletion.ports';
import { type DeletionObstacle, type SoleAdministeredOrganization } from '../../domain/user/account-deletion';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';

const PRODUCER = { producer: 'identity' } as const;

/** Statuts d'un compte qui ne compte plus comme administrateur d'une organisation. */
const LEAVING = ['deletion_pending', 'deleted'] as const;

/** Suppression des comptes (UC-ID-11, ADR-036), en base identity, avec l'outbox. */
@Injectable()
export class PrismaAccountDeletionRepository implements AccountDeletionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async soleAdministeredOrganizations(userId: string): Promise<SoleAdministeredOrganization[]> {
    const administered = await this.prisma.organizationMember.findMany({
      where: { userId, role: 'org_admin', removedAt: null, organization: { status: { not: 'rejected' } } },
      select: { organization: { select: { id: true, legalName: true } } },
      orderBy: { organizationId: 'asc' },
    });
    const sole: SoleAdministeredOrganization[] = [];
    for (const { organization } of administered) {
      const others = await this.prisma.organizationMember.count({
        where: {
          organizationId: organization.id,
          role: 'org_admin',
          removedAt: null,
          userId: { not: userId },
          user: { status: { notIn: [...LEAVING] } },
        },
      });
      if (others === 0) sole.push({ id: organization.id, legalName: organization.legalName });
    }
    return sole;
  }

  async requestDeletion(plan: DeletionRequestPlan): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: plan.userId, status: 'active' },
        data: {
          status: 'deletion_pending',
          deletionRequestedAt: plan.requestedAt,
          deletionScheduledFor: plan.scheduledFor,
          deletionCheckedAt: null,
          deletionPostponedBy: Prisma.DbNull,
        },
      });
      if (updated.count !== 1) return false;
      await tx.session.updateMany({
        where: { userId: plan.userId, revokedAt: null },
        data: { revokedAt: plan.requestedAt, revokeReason: 'account_deletion_requested' },
      });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope(
          'identity.user.deletion_requested',
          {
            userId: plan.userId,
            requestedAt: plan.requestedAt.toISOString(),
            scheduledFor: plan.scheduledFor.toISOString(),
          },
          { ...PRODUCER, occurredAt: plan.requestedAt },
        ),
      );
      return true;
    });
  }

  async cancelDeletion(userId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, status: 'deletion_pending' },
        data: {
          status: 'active',
          deletionRequestedAt: null,
          deletionScheduledFor: null,
          deletionCheckedAt: null,
          deletionPostponedBy: Prisma.DbNull,
        },
      });
      if (updated.count !== 1) return false;
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope('identity.user.deletion_cancelled', { userId }, { ...PRODUCER, occurredAt: now }),
      );
      return true;
    });
  }

  async listDue(input: { now: Date; recheckBefore: Date; limit: number }): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'deletion_pending',
        deletionScheduledFor: { lte: input.now },
        OR: [{ deletionCheckedAt: null }, { deletionCheckedAt: { lte: input.recheckBefore } }],
      },
      select: { id: true },
      orderBy: [{ deletionCheckedAt: { sort: 'asc', nulls: 'first' } }, { deletionScheduledFor: 'asc' }],
      take: input.limit,
    });
    return rows.map((row) => row.id);
  }

  async markChecked(userId: string, at: Date, obstacles?: DeletionObstacle[]): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, status: 'deletion_pending' },
      data: {
        deletionCheckedAt: at,
        ...(obstacles
          ? { deletionPostponedBy: obstacles.map((obstacle) => ({ ...obstacle })) as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async anonymize(userId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Garde : compte toujours en attente et échu (une annulation ou un autre passage l'emporte).
      const updated = await tx.user.updateMany({
        where: { id: userId, status: 'deletion_pending', deletionScheduledFor: { lte: now } },
        data: {
          status: 'deleted',
          firstName: null,
          lastName: null,
          email: null,
          emailVerifiedAt: null,
          preferredLanguage: 'fr',
          anonymizedAt: now,
          deletionCheckedAt: now,
          deletionPostponedBy: Prisma.DbNull,
        },
      });
      if (updated.count !== 1) return false;

      // Numéros libérés : un nouveau compte pourra s'inscrire avec. Les codes envoyés à ces
      // numéros (destinataire en clair) disparaissent avec eux.
      const phones = await tx.userPhone.findMany({ where: { userId }, select: { phoneE164: true } });
      await tx.userPhone.deleteMany({ where: { userId } });
      if (phones.length > 0) {
        await tx.otpChallenge.deleteMany({
          where: { target: { in: phones.map((phone) => phone.phoneE164) } },
        });
      }
      // Appareils et sessions (jetons de renouvellement par cascade), double authentification.
      await tx.session.deleteMany({ where: { userId } });
      await tx.mfaChallenge.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaFactor.deleteMany({ where: { userId } });
      // Historique des connexions gardé, sans adresse IP ni appareil.
      await tx.loginEvent.updateMany({ where: { userId }, data: { ip: null, userAgent: null } });
      // E-mails du profil effacés ; ceux de facturation d'une organisation restent (à l'entreprise).
      await tx.emailVerification.deleteMany({ where: { userId, organizationId: null } });
      await tx.emailVerification.updateMany({ where: { userId }, data: { ip: null } });
      await tx.roleAssignment.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });

      const memberships = await tx.organizationMember.findMany({
        where: { userId, removedAt: null },
        select: { id: true, organizationId: true },
      });
      for (const membership of memberships) {
        await tx.organizationMember.update({ where: { id: membership.id }, data: { removedAt: now } });
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope(
            'identity.member.removed',
            { organizationId: membership.organizationId, userId, removedBy: userId },
            { ...PRODUCER, occurredAt: now },
          ),
        );
      }

      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope('identity.user.deleted', { userId }, { ...PRODUCER, occurredAt: now }),
      );
      return true;
    });
  }
}
