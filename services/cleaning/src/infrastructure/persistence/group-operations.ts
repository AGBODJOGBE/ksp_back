import { type GroupOperationRecord, type GroupOutcome } from '../../application/ports';
import { json, type Tx } from './changes';

/**
 * Trace d'idempotence d'une opération de groupe (ADR-035), écrite dans la transaction de
 * l'opération : INSERT … ON CONFLICT DO NOTHING ; false si la clé est déjà enregistrée (appel
 * concurrent), la transaction est alors abandonnée par l'appelant.
 */
export async function recordGroupOperation(tx: Tx, operation: GroupOperationRecord): Promise<boolean> {
  const { count } = await tx.requestGroupOperation.createMany({
    data: [
      {
        actorId: operation.actorId,
        operation: operation.operation,
        idempotencyKey: operation.idempotencyKey,
        groupId: operation.outcome.groupId,
        outcome: json(operation.outcome),
        createdAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

export const outcomeFromJson = (value: unknown): GroupOutcome => value as GroupOutcome;
