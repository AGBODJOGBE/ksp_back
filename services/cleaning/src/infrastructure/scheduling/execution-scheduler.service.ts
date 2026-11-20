import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';
import { ExecutionTasks, type TaskReport } from '../../application/execution/execution-tasks';
import { PrismaService } from '../prisma/prisma.service';

export const EXECUTION_TASKS_INTERVAL_MS = Symbol('EXECUTION_TASKS_INTERVAL_MS');

/** Clé du verrou consultatif des tâches du lot E (valeur arbitraire, propre à cleaning). */
export const EXECUTION_TASKS_LOCK = 54_054_046;
/** Durée maximale d'un passage, verrou compris. */
const PASS_TIMEOUT_MS = 5 * 60_000;

/**
 * Tâches planifiées du lot E (UC-NT-46, SES-01, R-PP-05, R-PP-06, 15.4), sur le modèle de la v1 :
 * reprise des débits en cours, passage en retard et suspension, couverture des séances (alerte et
 * annulation sans agent), rappel de la veille et alerte de solde, factures de séance à émettre.
 * Un seul passage à la fois par instance, et pour l'ensemble des répliques : verrou consultatif
 * PostgreSQL pris pour la durée du passage (pg_try_advisory_xact_lock) ; une réplique qui ne
 * l'obtient pas saute son tour. Chaque écriture reste conditionnée par le statut et l'échéance.
 * Intervalle 0 : tâches désactivées.
 */
@Injectable()
export class ExecutionSchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ExecutionSchedulerService.name);
  private readonly tasks: ExecutionTasks;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
    @Inject(EXECUTION_TASKS_INTERVAL_MS) private readonly intervalMs: number,
  ) {
    this.tasks = new ExecutionTasks(deps as ExecutionDeps, (task, error) =>
      this.logger.warn(`Tâche ${task} : élément en échec (${(error as Error).message})`),
    );
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un passage ; rend faux si une autre réplique (ou cette instance) est déjà en train de passer. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${EXECUTION_TASKS_LOCK}) AS locked`;
          if (!lock?.locked) return false;
          await this.runAll();
          return true;
        },
        { maxWait: 10_000, timeout: PASS_TIMEOUT_MS },
      );
    } catch (error) {
      this.logger.error(`Tâches du lot E en échec : ${(error as Error).message}`);
      return false;
    } finally {
      this.running = false;
    }
  }

  /** Dans l'ordre : débits en cours, retards, couverture, rappels, factures. */
  async runAll(): Promise<void> {
    const steps: [string, () => Promise<TaskReport>][] = [
      ['reprise des débits', () => this.tasks.replayWalletOperations()],
      ['retards de paiement', () => this.tasks.markOverdue()],
      ['couverture des séances', () => this.tasks.watchStaffing()],
      ['rappels de la veille', () => this.tasks.sendReminders()],
      ['factures de séance', () => this.tasks.issuePendingInvoices()],
    ];
    for (const [name, step] of steps) {
      try {
        const { processed, failed } = await step();
        if (failed) this.logger.warn(`${name} : ${failed}/${processed + failed} en échec`);
      } catch (error) {
        this.logger.error(`${name} en échec : ${(error as Error).message}`);
      }
    }
  }
}
