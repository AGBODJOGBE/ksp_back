import { Logger } from '@nestjs/common';
import {
  type AnonymizationRun,
  type AnonymizeDueAccountsUseCase,
} from '../../application/deletion/account-deletion.use-cases';
import { AccountDeletionSchedulerService } from './account-deletion-scheduler.service';

function scheduler(run: () => Promise<AnonymizationRun>) {
  const useCase = { execute: jest.fn(run) } as unknown as AnonymizeDueAccountsUseCase;
  return { service: new AccountDeletionSchedulerService(useCase, 0), useCase };
}

describe('AccountDeletionSchedulerService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signale chaque report, sans coordonnées : compte et nature des obligations', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = scheduler(async () => ({
      anonymized: ['u-1'],
      postponed: [
        {
          userId: 'u-2',
          obstacles: [
            { service: 'billing', kind: 'unpaid_invoice', reference: 'FAC-1', description: 'Facture' },
            { service: 'billing', kind: 'unpaid_invoice', reference: 'FAC-2', description: 'Facture' },
          ],
        },
      ],
      unchecked: [{ userId: 'u-3', services: ['payment'] }],
    }));
    await service.tick();
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'Suppression du compte u-2 reportée : billing:unpaid_invoice.',
      'Suppression du compte u-3 reportée, services injoignables : payment.',
    ]);
  });

  it('une erreur est journalisée sans arrêter la tâche', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, useCase } = scheduler(async () => {
      throw new Error('base indisponible');
    });
    await service.tick();
    await service.tick();
    expect(useCase.execute).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('intervalle 0 : tâche désactivée', () => {
    const { service } = scheduler(async () => ({ anonymized: [], postponed: [], unchecked: [] }));
    const spy = jest.spyOn(global, 'setInterval');
    service.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
  });
});
