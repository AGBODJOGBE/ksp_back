import {
  type PhoneNormalizationStore,
  type PhoneRewriteOutcome,
  type StoredPhone,
} from '../../application/maintenance/normalize-phones.use-case';
import { Prisma } from '../../../prisma/generated';
import { type PrismaService } from '../prisma/prisma.service';

const PHONE_SELECT = { id: true, userId: true, phoneE164: true } as const;

/** Numéros des comptes (user_phones) pour le script phones:normalize. */
export class PrismaPhoneNormalizationStore implements PhoneNormalizationStore {
  constructor(private readonly prisma: PrismaService) {}

  async page(afterId: string | null, limit: number): Promise<StoredPhone[]> {
    return this.prisma.userPhone.findMany({
      where: afterId ? { id: { gt: afterId } } : {},
      orderBy: { id: 'asc' },
      take: limit,
      select: PHONE_SELECT,
    });
  }

  async findByNumber(phoneE164: string): Promise<StoredPhone | null> {
    return this.prisma.userPhone.findUnique({ where: { phoneE164 }, select: PHONE_SELECT });
  }

  async rewrite(id: string, from: string, to: string): Promise<PhoneRewriteOutcome> {
    try {
      const updated = await this.prisma.userPhone.updateMany({
        where: { id, phoneE164: from },
        data: { phoneE164: to },
      });
      return updated.count === 1 ? 'rewritten' : 'changed';
    } catch (error) {
      // Contrainte d'unicité de phone_e164 : jamais de doublon, même en cas de course.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'taken';
      throw error;
    }
  }
}
