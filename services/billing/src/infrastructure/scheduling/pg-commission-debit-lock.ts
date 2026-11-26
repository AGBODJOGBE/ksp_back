import { type CommissionDebitLock } from '../../application/recovery/ports';
import {
  COMMISSION_BILLING_LOCK,
  COMMISSION_BILLING_MAX_RUN_MS,
} from './commission-billing-scheduler.service';
import { type PgRunLock } from './pg-run-lock';

/**
 * Verrou des débits de commission (ADR-064) : le verrou consultatif de la tâche planifiée du
 * recouvrement, pris sans attendre par le nouvel essai qui suit un crédit du portefeuille. Tâche et
 * nouvel essai ne débitent donc jamais en même temps, quelle que soit la réplique.
 */
export class PgCommissionDebitLock implements CommissionDebitLock {
  constructor(private readonly lock: PgRunLock) {}

  tryRun<T>(run: () => Promise<T>): Promise<{ ran: true; result: T } | { ran: false }> {
    return this.lock.tryRun(COMMISSION_BILLING_LOCK, run, COMMISSION_BILLING_MAX_RUN_MS);
  }
}
