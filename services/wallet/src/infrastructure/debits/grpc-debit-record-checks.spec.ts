import { type billingV1, type cleaningV1 } from '@ksp/contracts';
import { GrpcCaller } from '@ksp/platform';
import { of } from 'rxjs';
import { GrpcDebitRecordChecks } from './grpc-debit-record-checks';

/**
 * Adaptateur du rapprochement des débits (ADR-048, RV-80) : statut lu chez cleaning (frais de visite,
 * séance), booléen lu chez billing (facture) ; débit v1 d'une mission jamais soumis à cleaning.
 */
const OBJECT_ID = '0192f1c4-0000-7000-8000-00000000e001';
const TRANSACTION_ID = '0192f1c4-0000-7000-8000-00000000e002';

function checks(cleaningStatus: string, billingRecorded = true) {
  const asked: { service: string; request: unknown }[] = [];
  const cleaning = {
    getWalletDebitStatus: (request: cleaningV1.GetWalletDebitStatusRequest) => {
      asked.push({ service: 'cleaning', request });
      return of({ recorded: cleaningStatus === 'recorded', status: cleaningStatus });
    },
  } as unknown as cleaningV1.WalletDebitCheckServiceClient;
  const billing = {
    getWalletDebitStatus: (request: billingV1.GetWalletDebitStatusRequest) => {
      asked.push({ service: 'billing', request });
      return of({ recorded: billingRecorded });
    },
  } as unknown as billingV1.WalletDebitCheckServiceClient;
  const adapter = new GrpcDebitRecordChecks(
    { client: cleaning, caller: new GrpcCaller({ target: 'cleaning' }) },
    { client: billing, caller: new GrpcCaller({ target: 'billing' }) },
  );
  return { adapter, asked };
}

const debit = (caller: string, objectType: string) => ({
  caller,
  objectType,
  objectId: OBJECT_ID,
  transactionId: TRANSACTION_ID,
});

describe('« débit enregistré ? » chez cleaning et billing', () => {
  it('cleaning : statut rendu tel quel, objet et débit transmis', async () => {
    for (const status of ['recorded', 'not_recorded', 'in_progress']) {
      const { adapter, asked } = checks(status);
      expect(await adapter.debitStatus(debit('cleaning', 'cleaning_session'))).toBe(status);
      expect(asked).toEqual([
        {
          service: 'cleaning',
          request: { objectType: 'cleaning_session', objectId: OBJECT_ID, transactionId: TRANSACTION_ID },
        },
      ]);
    }
    const { adapter } = checks('in_progress');
    expect(await adapter.debitStatus(debit('cleaning', 'cleaning_visit_fee'))).toBe('in_progress');
  });

  it('cleaning : statut inconnu ou absent, erreur (relu au passage suivant, jamais remboursé)', async () => {
    for (const status of ['', 'paid']) {
      await expect(checks(status).adapter.debitStatus(debit('cleaning', 'cleaning_session'))).rejects.toThrow(
        'Statut de débit inconnu',
      );
    }
  });

  it('billing : booléen traduit en statut', async () => {
    expect(await checks('recorded', true).adapter.debitStatus(debit('billing', 'billing_invoice'))).toBe(
      'recorded',
    );
    expect(await checks('recorded', false).adapter.debitStatus(debit('billing', 'billing_invoice'))).toBe(
      'not_recorded',
    );
  });

  it('débit d’une mission v1, autre objet ou autre service : non couvert, rien n’est demandé', async () => {
    const { adapter, asked } = checks('not_recorded');
    expect(await adapter.debitStatus(debit('cleaning', 'cleaning_mission'))).toBeNull();
    expect(await adapter.debitStatus(debit('billing', 'cleaning_session'))).toBeNull();
    expect(await adapter.debitStatus(debit('recovery', 'recovery_installment'))).toBeNull();
    expect(asked).toEqual([]);
  });
});
