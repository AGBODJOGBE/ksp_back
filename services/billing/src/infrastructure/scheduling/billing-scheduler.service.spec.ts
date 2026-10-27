import { type BillingUseCases } from '../../application/use-cases';
import { BillingSchedulerService } from './billing-scheduler.service';

function scheduler(issue: () => Promise<{ issued: number; deferredContractIds: string[] }>) {
  const overdue = jest.fn(async () => ({ overdue: 1 }));
  const useCases = {
    issueDueInvoices: { execute: issue },
    markOverdueInvoices: { execute: overdue },
  } as unknown as BillingUseCases;
  return { overdue, service: new BillingSchedulerService(useCases, 0) };
}

describe('BillingSchedulerService', () => {
  it('émission en échec (identity indisponible) : le passage en impayée a tout de même lieu', async () => {
    const { service, overdue } = scheduler(async () => {
      throw new Error('identity indisponible');
    });
    await expect(service.tick()).resolves.toBeUndefined();
    expect(overdue).toHaveBeenCalledTimes(1);
  });

  it('un passage à la fois : un second appel pendant le premier ne fait rien', async () => {
    let release: () => void = () => undefined;
    const { service, overdue } = scheduler(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ issued: 0, deferredContractIds: ['0192f1c4-0000-7000-8000-0000000000b1'] });
        }),
    );
    const first = service.tick();
    await service.tick();
    release();
    await first;
    expect(overdue).toHaveBeenCalledTimes(1);
  });
});
