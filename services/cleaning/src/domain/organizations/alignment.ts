import { type CatchUpProposal, type ResumableSession, resumeSessions } from '../programs/catch-up';
import {
  type ActiveCause,
  addSuspensionCause,
  liftSuspensionCause,
  type SuspendableProgram,
  type SuspensionCauseCode,
} from '../programs/suspension';
import { type StandingDecision } from './standing';

/**
 * Application d'une décision d'impayés aux programmes d'une organisation (lot F ; R-PE-06,
 * R-SU-01 à R-SU-03). Réutilise les causes cumulables de `programs/suspension.ts` et la reprise des
 * séances de `programs/catch-up.ts` : un programme ne reprend que quand toutes ses causes sont
 * levées ; une cause ajoutée ou levée sur un programme qui reste suspendu est annoncée
 * (`cleaning.program.suspension_updated`, RV-84) ; à la reprise, les séances suspendues repassent
 * « à affecter » ou reçoivent une date de rattrapage (réaffectation, R-SU-03).
 */
export interface OrganizationProgram extends SuspendableProgram {
  id: string;
  sessions: ReadonlyArray<ResumableSession & { agentIds: readonly string[] }>;
}

export interface ResumptionPlan {
  /** Séances suspendues qui repassent « à affecter » : la planification leur cherche des agents. */
  toAssign: string[];
  /** Séances trop proches ou passées : date de rattrapage proposée au superviseur. */
  catchUp: CatchUpProposal[];
}

export type ProgramChange =
  | {
      programId: string;
      effect: 'suspended';
      program: SuspendableProgram;
      causes: SuspensionCauseCode[];
      suspendedSessionIds: string[];
      releasedAgentIds: string[];
    }
  | {
      programId: string;
      effect: 'cause_added' | 'cause_lifted';
      program: SuspendableProgram;
      causes: SuspensionCauseCode[];
    }
  | {
      programId: string;
      effect: 'resumed';
      program: SuspendableProgram;
      liftedCause: SuspensionCauseCode;
      resumption: ResumptionPlan;
    };

const codes = (causes: readonly ActiveCause[]) => causes.map((cause) => cause.cause);

/**
 * Changements à enregistrer (et annoncer) pour chaque programme visé par la décision ; un programme
 * sans effet n'apparaît pas. `resume` : règles de reprise des séances (délai minimum avant une
 * séance, jours exclus et fériés, limite de recherche du rattrapage).
 */
export function alignPrograms(input: {
  programs: readonly OrganizationProgram[];
  decision: Pick<StandingDecision, 'addCause' | 'liftCause'>;
  now: Date;
  resume: {
    firstSessionLeadHours: number;
    /** Jours exclus et fériés de chaque programme (AAAA-MM-JJ, Porto-Novo). */
    excludedDays: (programId: string) => ReadonlySet<string>;
    maxWeeks: number;
  };
}): ProgramChange[] {
  const changes: ProgramChange[] = [];
  for (const current of input.programs) {
    if (input.decision.addCause.includes(current.id)) {
      const result = addSuspensionCause(current, current.sessions, {
        cause: 'unpaid_invoices',
        now: input.now,
      });
      if (result.effect === 'suspended') {
        changes.push({
          programId: current.id,
          effect: 'suspended',
          program: result.program,
          causes: codes(result.program.causes),
          suspendedSessionIds: result.suspendedSessionIds,
          releasedAgentIds: result.releasedAgentIds,
        });
      } else if (result.effect === 'cause_added') {
        changes.push({
          programId: current.id,
          effect: 'cause_added',
          program: result.program,
          causes: codes(result.program.causes),
        });
      }
    } else if (input.decision.liftCause.includes(current.id)) {
      const result = liftSuspensionCause(current, current.sessions, { cause: 'unpaid_invoices' });
      if (result.effect === 'resumed') {
        changes.push({
          programId: current.id,
          effect: 'resumed',
          program: result.program,
          liftedCause: 'unpaid_invoices',
          resumption: resumeSessions({
            sessions: current.sessions,
            now: input.now,
            firstSessionLeadHours: input.resume.firstSessionLeadHours,
            excludedDays: input.resume.excludedDays(current.id),
            maxWeeks: input.resume.maxWeeks,
          }),
        });
      } else if (result.effect === 'cause_lifted') {
        changes.push({
          programId: current.id,
          effect: 'cause_lifted',
          program: result.program,
          causes: codes(result.program.causes),
        });
      }
    }
  }
  return changes;
}

/** Un programme a-t-il repris ? Alors la situation est réévaluée (avertissement, R-SU-01). */
export function hasResumedProgram(changes: readonly ProgramChange[]): boolean {
  return changes.some((change) => change.effect === 'resumed');
}
