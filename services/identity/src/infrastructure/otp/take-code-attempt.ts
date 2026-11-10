import { Prisma } from '../../../prisma/generated';

/**
 * Prend un essai sur une demande de code encore utilisable, en une seule instruction : l'essai est
 * compté avant la comparaison, si bien que des essais simultanés ne dépassent jamais le plafond
 * (ADR-050). Renvoie le nombre d'essais, ou null si la demande n'est plus utilisable.
 */
export async function takeCodeAttempt(
  prisma: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  table: 'otp_challenges' | 'email_verifications',
  input: { id: string; maxAttempts: number; now: Date },
): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE ${Prisma.raw(`"${table}"`)} SET "attempts" = "attempts" + 1
    WHERE "id" = ${input.id}::uuid AND "attempts" < ${input.maxAttempts}
      AND "consumed_at" IS NULL AND "sent_at" IS NOT NULL AND "send_failed_at" IS NULL
      AND "expires_at" > ${input.now}
    RETURNING "attempts"`;
  return rows[0]?.attempts ?? null;
}
