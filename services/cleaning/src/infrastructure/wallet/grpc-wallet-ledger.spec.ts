import { type walletV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { GrpcWalletLedger } from './grpc-wallet-ledger';

const DEBIT = {
  idempotencyKey: 'session:0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e01:1',
  holder: { type: 'user' as const, id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11' },
  amount: 25_000,
  object: { objectType: 'cleaning_session', objectId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e01', part: '' },
  description: 'Nettoyage — séance du 1er décembre',
};

function ledger(answer: (request: walletV1.DebitRequest) => unknown) {
  const debits: walletV1.DebitRequest[] = [];
  const refunds: walletV1.RefundRequest[] = [];
  const client = {
    debit: (request: walletV1.DebitRequest) => {
      debits.push(request);
      return answer(request);
    },
    refund: (request: walletV1.RefundRequest) => {
      refunds.push(request);
      return of({ created: true });
    },
  } as unknown as walletV1.WalletServiceClient;
  return {
    debits,
    refunds,
    wallet: new GrpcWalletLedger(client, new GrpcCaller({ target: 'wallet', retryBackoffMs: 1 })),
  };
}

describe('GrpcWalletLedger', () => {
  it('débit en XOF avec la clé et l’objet payé ; remboursement d’un débit', async () => {
    const { wallet, debits, refunds } = ledger(() =>
      of({ transaction: { id: 't-1', amount: { amount: 25_000, currency: 'XOF' } }, created: true }),
    );
    await expect(wallet.debit(DEBIT)).resolves.toEqual({
      transactionId: 't-1',
      amount: 25_000,
      created: true,
    });
    expect(debits).toEqual([
      {
        idempotencyKey: DEBIT.idempotencyKey,
        holder: DEBIT.holder,
        amount: { amount: 25_000, currency: 'XOF' },
        object: { service: '', ...DEBIT.object },
        description: DEBIT.description,
      },
    ]);
    await wallet.refund({ transactionId: 't-1', reason: 'Séance annulée' });
    expect(refunds).toEqual([{ transactionId: 't-1', reason: 'Séance annulée' }]);
  });

  it('réponse sans débit : erreur ; solde insuffisant : erreur de wallet transmise telle quelle', async () => {
    await expect(ledger(() => of({ created: false })).wallet.debit(DEBIT)).rejects.toThrow(
      'Réponse de wallet sans débit.',
    );
    const insufficient = ledger(() =>
      throwError(
        () =>
          new AppError('FAILED_PRECONDITION', 'WALLET_INSUFFICIENT_FUNDS', 'Solde insuffisant.', {
            missing: 5000,
          }),
      ),
    );
    await expect(insufficient.wallet.debit(DEBIT)).rejects.toMatchObject({
      code: 'WALLET_INSUFFICIENT_FUNDS',
      details: { missing: 5000 },
    });
  });
});
