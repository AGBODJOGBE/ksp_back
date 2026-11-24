import { type ExecutionDeps } from '../deps';
import { type IdempotencyStub, runIdempotent } from '../shared/idempotency';
import { executionError } from './execution-errors';
import { type ProgramRecord, type SessionPatch, type SessionRecord } from './execution.ports';
import { type Effects, lockedProgram } from './execution-support';
import { type ChangeContext } from './session-changes';
import { type SessionPayments } from './session-payments';

/**
 * Déroulé commun d'une écriture du lot E (règle d'or n° 3) : clé d'idempotence, programme
 * verrouillé et relu, décision du domaine, état, événements, traces et clé écrits dans une seule
 * transaction ; débit des séances closes ensuite (UC-NT-46), hors transaction.
 */
export interface ActionDecision {
  /** Changement de la séance visée (actions sur une séance). */
  patch?: SessionPatch;
  effects: Effects;
  /** Séances à débiter après la transaction. */
  collect?: string[];
}

export async function executionAction<T>(
  deps: ExecutionDeps,
  payments: SessionPayments,
  input: {
    actorId: string;
    operation: string;
    key: string;
    body: unknown;
    programId: string;
    /** Séance visée ; absente pour une action sur le programme. */
    sessionId?: string;
    /**
     * Organisation dont la décision dépend (RV-85) : son verrou est pris avant celui du programme,
     * et sa situation est donnée à `decide`.
     */
    organizationId?: string | null;
    decide: (ctx: ChangeContext) => Promise<ActionDecision>;
    view: () => Promise<T>;
  },
): Promise<T> {
  return runIdempotent({
    store: deps.idempotency,
    actorId: input.actorId,
    operation: input.operation,
    key: input.key,
    body: input.body,
    at: deps.clock.now(),
    replay: input.view,
    run: async (stub: IdempotencyStub) => {
      let collect: string[] = [];
      try {
        await deps.execution.transaction(async (tx) => {
          const organization = input.organizationId ? await tx.organization(input.organizationId) : null;
          const { program, sessions } = await lockedProgram(tx, input.programId);
          const session = input.sessionId
            ? sessions.find((line) => line.id === input.sessionId)!
            : sessions[0]!;
          const settings = await tx.settings();
          const now = deps.clock.now();
          const decision = await input.decide({
            tx,
            program,
            sessions,
            session,
            settings,
            now,
            organization,
          });
          if (input.sessionId && decision.patch && Object.keys(decision.patch).length > 0) {
            await tx.updateSession(input.sessionId, session.version, decision.patch);
          }
          await tx.write({
            ...decision.effects,
            idempotency: stub({
              programId: input.programId,
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            }),
          });
          collect = decision.collect ?? [];
        });
      } catch (error) {
        throw executionError(error);
      }
      for (const sessionId of collect) await payments.collect(sessionId, 'close');
      return input.view();
    },
  });
}

/** Séance et programme du périmètre ; rien d'autre n'est révélé (partie 16.3). */
export interface Scoped {
  program: ProgramRecord;
  session: SessionRecord;
}
