import { type AuditEntry } from '../ports';

/**
 * Traces du catalogue et des zones (R-AU-01) : avant et après des seules valeurs sans texte libre
 * (codes, identifiants, montants, coefficients, ordres, états) ; un texte modifié (nom, libellé,
 * description) n'est cité que par le nom de son champ.
 */
type Snapshot = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function auditOf(input: {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  at: Date;
  before: Snapshot | null;
  after: Snapshot;
  /** Champs dont la valeur peut être tracée ; les autres ne sont cités que par leur nom. */
  traced: readonly string[];
  extra?: Snapshot;
}): AuditEntry {
  const keys = Object.keys(input.after);
  const changed =
    input.before === null ? keys : keys.filter((key) => !same(input.before?.[key], input.after[key]));
  const pick = (snapshot: Snapshot) =>
    Object.fromEntries(
      changed.filter((key) => input.traced.includes(key)).map((key) => [key, snapshot[key] ?? null]),
    );
  return {
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    at: input.at,
    details: {
      fields: changed,
      ...(input.before === null ? {} : { before: pick(input.before) }),
      after: pick(input.after),
      ...input.extra,
    },
  };
}
