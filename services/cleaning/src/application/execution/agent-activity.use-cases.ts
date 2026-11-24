import { currentContext } from '@ksp/platform';
import { addDays, isoWeekMonday, localDayStart, localPosition } from '../../domain/planning/time';
import { type AgentStatsRecord } from '../agents/agent.ports';
import { type ExecutionDeps } from '../deps';
import { requireConnectedUser } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { executionErrors } from './execution-errors';
import { type SessionRecord } from './execution.ports';

/**
 * « Mon activité » de l'agent (13.2, UC-NT-21) : statistiques de sa fiche et heures réalisées par
 * semaine (12 dernières) et par mois (6 derniers), heure de Porto-Novo, sans montants (R-EX-04).
 */
export const ACTIVITY_WEEKS = 12;
export const ACTIVITY_MONTHS = 6;

export interface ActivityPeriod {
  periodStart: string;
  hours: number;
  sessionsCompleted: number;
}

export interface AgentActivityView {
  stats: AgentStatsRecord & { ratingAverage: number | null; ratingsCount: number };
  weeks: ActivityPeriod[];
  months: ActivityPeriod[];
}

const hoursOf = (session: SessionRecord) =>
  session.startedAt && session.completedAt
    ? (session.completedAt.getTime() - session.startedAt.getTime()) / 3_600_000
    : 0;

const round = (hours: number) => Math.round(hours * 100) / 100;

export class AgentActivityUseCase {
  constructor(private readonly deps: ExecutionDeps) {}

  async execute(): Promise<AgentActivityView> {
    const userId = requireConnectedUser();
    const agent = await this.deps.planning.agentByUserId(userId);
    if (!agent) throw cleaningErrors.agentNotFound();
    const now = this.deps.clock.now();
    const today = localPosition(now).day;
    const firstWeek = addDays(isoWeekMonday(today), -7 * (ACTIVITY_WEEKS - 1));
    const firstMonth = monthsBack(today, ACTIVITY_MONTHS - 1);
    const from = localDayStart(firstWeek < firstMonth ? firstWeek : firstMonth);
    const [stats, sessions] = await Promise.all([
      this.deps.planning.agentStats([agent.id], now),
      this.deps.execution.agentSessions(agent.id, from, now),
    ]);
    const completed = sessions.filter((session) => session.status === 'completed');
    const weeks = Array.from({ length: ACTIVITY_WEEKS }, (_, index) =>
      addDays(firstWeek, 7 * index),
    ).reverse();
    const months = Array.from({ length: ACTIVITY_MONTHS }, (_, index) => monthsBack(today, index));
    const period = (key: (day: string) => string, start: string): ActivityPeriod => {
      const inside = completed.filter(
        (session) => key(localPosition(session.completedAt ?? session.scheduledStart).day) === start,
      );
      return {
        periodStart: start,
        hours: round(inside.reduce((total, session) => total + hoursOf(session), 0)),
        sessionsCompleted: inside.length,
      };
    };
    const record = stats.get(agent.id) ?? {
      sessionsCompleted: 0,
      visitsCompleted: 0,
      hoursThisWeek: 0,
      hoursThisMonth: 0,
      openClaims: 0,
    };
    return {
      stats: {
        ...record,
        ratingAverage: agent.ratingCount ? agent.ratingSum / agent.ratingCount : null,
        ratingsCount: agent.ratingCount,
      },
      weeks: weeks.map((start) => period(isoWeekMonday, start)),
      months: months.map((start) => period((day) => `${day.slice(0, 7)}-01`, start)),
    };
  }
}

/** Premier jour du mois, `count` mois avant celui du jour donné (AAAA-MM-01). */
function monthsBack(day: string, count: number): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) - count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}

/**
 * Rapprochement des débits par wallet (RV-80, 15.4) : un débit qu'aucun objet de cleaning ne cite
 * est remboursé par wallet ; un débit en cours chez cleaning ne l'est jamais.
 */
export class WalletDebitStatusUseCase {
  constructor(private readonly deps: ExecutionDeps) {}

  async execute(input: {
    objectType: string;
    objectId: string;
    transactionId: string;
  }): Promise<{ recorded: boolean; status: 'recorded' | 'not_recorded' | 'in_progress' }> {
    const caller = currentContext()?.callerService;
    if (caller !== undefined && caller !== 'wallet') throw executionErrors.callerForbidden();
    if (input.objectType !== 'cleaning_session' && input.objectType !== 'cleaning_visit_fee') {
      return { recorded: false, status: 'not_recorded' };
    }
    const operations = await this.deps.execution.walletOperationsFor({
      type: input.objectType,
      id: input.objectId,
    });
    if (
      operations.some(
        (operation) =>
          operation.walletTransactionId === input.transactionId && operation.status === 'succeeded',
      )
    ) {
      return { recorded: true, status: 'recorded' };
    }
    if (operations.some((operation) => operation.status === 'pending')) {
      return { recorded: false, status: 'in_progress' };
    }
    return { recorded: false, status: 'not_recorded' };
  }
}
