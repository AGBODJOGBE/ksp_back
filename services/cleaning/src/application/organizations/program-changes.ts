import { type OrganizationProgram, type ProgramChange } from '../../domain/organizations/alignment';
import { type unpaidWarningPayload } from '../../domain/organizations/standing';
import { isTerminalProgram } from '../../domain/programs/program-status';
import { type SuspensionCauseCode } from '../../domain/programs/suspension';
import { type ExecutionTx, type ProgramRecord, type SessionRecord } from '../execution/execution.ports';
import {
  applyAddCause,
  applyLiftCause,
  type Effects,
  lockedProgram,
  merge,
  SYSTEM_ACTOR,
} from '../execution/execution-support';
import { type Changes } from '../ports';
import { type ProgramCauseEffect } from './organizations.ports';

/**
 * Écritures des programmes d'une organisation (piste O) : elles passent par la suspension et la
 * reprise du lot E (`applyAddCause`, `applyLiftCause` : statut, historique des causes, séances
 * gelées ou reprises, agents libérés, rattrapages, événements et traces), sans les doubler.
 * L'acteur est toujours `system`.
 */

/** Programme tel que le domaine le lit : causes actives, séances et leurs agents. */
export function organizationProgram(
  program: ProgramRecord,
  sessions: readonly SessionRecord[],
): OrganizationProgram {
  return {
    id: program.id,
    status: program.status,
    causes: program.causes,
    suspendedAt: program.suspendedAt,
    sessions: sessions.map((session) => ({
      id: session.id,
      rank: session.rank,
      status: session.status,
      scheduledStart: session.scheduledStart,
      scheduledEnd: session.scheduledEnd,
      agentIds: session.agents.map((agent) => agent.agentId),
    })),
  };
}

/**
 * Programmes non terminés, verrouillés puis relus dans l'ordre de leurs identifiants : deux
 * transactions qui visent les mêmes programmes prennent leurs verrous dans le même ordre.
 */
export async function lockedOrganizationPrograms(
  tx: ExecutionTx,
  programIds: readonly string[],
): Promise<OrganizationProgram[]> {
  const programs: OrganizationProgram[] = [];
  for (const programId of [...programIds].sort()) {
    const { program, sessions } = await lockedProgram(tx, programId);
    if (!isTerminalProgram(program.status)) programs.push(organizationProgram(program, sessions));
  }
  return programs;
}

/** Pose ou lève une cause sur des programmes, chacun relu sous son verrou. */
export async function writeCauseChanges(
  tx: ExecutionTx,
  input: {
    changes: ReadonlyArray<{ programId: string; action: 'add' | 'lift' }>;
    cause: SuspensionCauseCode;
    /** Factures impayées de l'organisation, pour la cause « factures impayées » seulement. */
    unpaidCount: number | null;
    /** Seuil franchi (cause « factures impayées »). */
    threshold: number | null;
    at: Date;
  },
): Promise<ProgramCauseEffect[]> {
  if (input.changes.length === 0) return [];
  const settings = await tx.settings();
  const effects: Effects[] = [];
  const outcomes: ProgramCauseEffect[] = [];
  for (const change of input.changes) {
    const { program, sessions } = await lockedProgram(tx, change.programId);
    const applied =
      change.action === 'add'
        ? await applyAddCause(tx, program, sessions, {
            cause: input.cause,
            now: input.at,
            unpaidCount: input.unpaidCount,
            threshold: input.threshold,
          })
        : await applyLiftCause(tx, program, sessions, {
            cause: input.cause,
            now: input.at,
            liftedBy: null,
            firstSessionLeadHours: settings.firstSessionLeadHours,
            unpaidCount: input.unpaidCount,
          });
    effects.push({ events: applied.events, audit: applied.audit });
    outcomes.push({ programId: change.programId, effect: applied.effect });
  }
  await tx.write(merge(...effects));
  return outcomes;
}

/**
 * Changements décidés par le domaine pour la cause « factures impayées » (`alignPrograms`). Le lot E
 * refait la décision sur le programme verrouillé : un effet différent de celui du domaine annule la
 * transaction (l'événement reçu sera rejoué).
 */
export async function writeUnpaidProgramChanges(
  tx: ExecutionTx,
  changes: readonly ProgramChange[],
  context: { unpaidCount: number; threshold: number; at: Date },
): Promise<void> {
  const outcomes = await writeCauseChanges(tx, {
    changes: changes.map((change) => ({
      programId: change.programId,
      action: change.effect === 'suspended' || change.effect === 'cause_added' ? 'add' : 'lift',
    })),
    cause: 'unpaid_invoices',
    unpaidCount: context.unpaidCount,
    threshold: context.threshold,
    at: context.at,
  });
  changes.forEach((change, index) => {
    const applied = outcomes[index]!.effect;
    if (applied !== change.effect) {
      throw new Error(
        `Programme ${change.programId} : changement « ${change.effect} » décidé, « ${applied} » appliqué.`,
      );
    }
  });
}

/** Avertissement d'impayés (R-PE-06, RV-83) : événement et trace, identifiants seulement. */
export function unpaidWarningChanges(payload: ReturnType<typeof unpaidWarningPayload>): Changes {
  return {
    events: [{ type: 'cleaning.organization.unpaid_warning', payload }],
    audit: [
      {
        actorId: SYSTEM_ACTOR,
        action: 'organization.unpaid_warning',
        entityType: 'organization',
        entityId: payload.organizationId,
        at: new Date(payload.warnedAt),
        details: {
          unpaidCount: payload.unpaidCount,
          warningThreshold: payload.warningThreshold,
          suspensionThreshold: payload.suspensionThreshold,
          overdueInvoiceIds: payload.overdueInvoiceIds,
        },
      },
    ],
  };
}
