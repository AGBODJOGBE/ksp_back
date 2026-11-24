import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type NewPendingAccount,
  type PendingAccountRepository,
  type PhoneAccount,
} from '../../application/provisioning/phone-accounts.ports';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Comptes créés à la demande d'un service (EnsureUserByPhone), en base identity : compte « en
 * attente de vérification », numéro principal non vérifié, événement identity.user.registered
 * (sans téléphone, comme à la première vérification) et trace d'audit, dans une seule transaction.
 * L'index unique des numéros garantit qu'un numéro ne porte qu'un compte, même entre deux appels
 * simultanés ou face à la première connexion du titulaire.
 */
@Injectable()
export class PrismaPendingAccountRepository implements PendingAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPending(account: NewPendingAccount): Promise<PhoneAccount & { created: boolean }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: account.userId,
            status: 'pending_verification',
            firstName: account.firstName,
            lastName: account.lastName,
            createdAt: account.now,
            phones: {
              create: {
                id: account.phoneId,
                phoneE164: account.phoneE164,
                isPrimary: true,
                // Vérifié à la première connexion par code du titulaire (completePhoneLogin).
                verifiedAt: null,
              },
            },
          },
        });
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope(
            'identity.user.registered',
            { userId: account.userId, method: 'phone' },
            { producer: 'identity', occurredAt: account.now },
          ),
        );
        // Qui : le service appelant, et le membre du personnel à l'origine. Jamais le numéro.
        await tx.auditEntry.create({
          data: {
            id: account.audit.id,
            actorId: account.audit.service,
            action: 'user.registered_by_service',
            entityType: 'user',
            entityId: account.userId,
            at: account.now,
            details: { requestedBy: account.audit.requestedBy },
          },
        });
      });
      return { userId: account.userId, status: 'pending_verification', created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      // Numéro pris entre-temps : la transaction n'a rien écrit, le compte de ce numéro est rendu.
      const phone = await this.prisma.userPhone.findUnique({
        where: { phoneE164: account.phoneE164 },
        select: { user: { select: { id: true, status: true } } },
      });
      if (!phone) throw error;
      return { userId: phone.user.id, status: phone.user.status, created: false };
    }
  }
}
