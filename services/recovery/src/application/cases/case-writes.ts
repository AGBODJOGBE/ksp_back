import { CaseErrors } from './case-errors';
import { type CaseChanges, type CaseRepository, type RecoveryCaseRecord } from './ports';

/**
 * Enregistre un dossier sous verrou optimiste et rend l'état enregistré (version suivante). Une
 * modification concurrente annule tout : rien n'est écrit, le client recharge le dossier.
 */
export async function persist(
  cases: CaseRepository,
  record: RecoveryCaseRecord,
  changes: CaseChanges,
  options: { content?: boolean; now?: Date } = {},
): Promise<RecoveryCaseRecord> {
  const lastAction = changes.evidence.reduce<Date | null>(
    (latest, entry) => (latest === null || entry.occurredAt > latest ? entry.occurredAt : latest),
    record.lastActionAt,
  );
  const next: RecoveryCaseRecord = {
    ...record,
    lastActionAt: lastAction,
    updatedAt: options.now ?? record.updatedAt,
  };
  const outcome = await cases.save(next, changes, options.content ? { content: true } : {});
  if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
  return { ...next, version: record.version + 1 };
}
