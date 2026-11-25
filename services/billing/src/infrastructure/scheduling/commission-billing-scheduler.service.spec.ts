import { type RecoveryBillingUseCases } from '../../application/recovery/use-cases';
import { CommissionBillingSchedulerService } from './commission-billing-scheduler.service';
import { type PgRunLock } from './pg-run-lock';

/** Verrou toujours obtenu : le passage s'exécute aussitôt. */
const freeLock = {
  tryRun: async <T>(_name: string, run: () => Promise<T>) => ({ ran: true as const, result: await run() }),
} as unknown as PgRunLock;

function scheduler(issue: () => Promise<{ issued: number; deferredOrganizationIds: string[] }>) {
  const debit = jest.fn(async () => ({
    paid: 1,
    failures: [
      {
        invoiceId: '0192f1c4-0000-7000-8000-0000000000f1',
        invoiceNumber: 'FCR-2026-000002',
        reason: 'insufficient_funds' as const,
        code: 'WALLET_INSUFFICIENT_FUNDS',
      },
    ],
  }));
  const useCases = {
    issueCommissionInvoices: { execute: issue },
    debitCommissionInvoices: { execute: debit },
  } as unknown as RecoveryBillingUseCases;
  return { debit, service: new CommissionBillingSchedulerService(useCases, freeLock, 0) };
}

describe('CommissionBillingSchedulerService (ADR-064)', () => {
  it('émission en échec (identity indisponible) : le débit des commissions a tout de même lieu', async () => {
    const { service, debit } = scheduler(async () => {
      throw new Error('identity indisponible');
    });
    await expect(service.tick()).resolves.toBe('ran');
    expect(debit).toHaveBeenCalledTimes(1);
  });

  it('un passage à la fois : un second appel pendant le premier est sauté', async () => {
    let release: () => void = () => undefined;
    const { service, debit } = scheduler(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ issued: 1, deferredOrganizationIds: [] });
        }),
    );
    const first = service.tick();
    expect(await service.tick()).toBe('skipped');
    release();
    expect(await first).toBe('ran');
    expect(debit).toHaveBeenCalledTimes(1);
  });
});
