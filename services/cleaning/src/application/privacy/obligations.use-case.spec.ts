import { type AppError, runWithContext } from '@ksp/platform';
import { type PrivacyDeps } from '../deps';
import { type CaseRecord, type Owner } from '../requests/requests.ports';
import { HasPendingObligationsUseCase } from './obligations.use-case';
import { type StoredObligations } from './privacy.ports';

const NOW = new Date('2026-11-23T10:00:00Z');
const USER = '0192f1c4-0000-7000-8000-00000000c001';
const ORGANIZATION = '0192f1c4-0000-7000-8000-0000000000a1';

const NOTHING: StoredObligations = {
  programs: [],
  unpaidSessions: [],
  walletOperations: [],
  directPayments: [],
  overdueInvoices: 0,
  assignments: [],
};

/** Dossier réduit à ce que lit le statut effectif : statut, devis envoyé, frais à payer. */
function caseRecord(
  number: string,
  status: string,
  extra: { validUntil?: Date; feeDueAt?: Date } = {},
): CaseRecord {
  return {
    request: { number, status },
    quotes: extra.validUntil ? [{ status: 'sent', validUntil: extra.validUntil }] : [],
    fees: extra.feeDueAt ? [{ status: 'awaiting_payment', dueAt: extra.feeDueAt }] : [],
  } as unknown as CaseRecord;
}

function setup(stored: Partial<StoredObligations> = {}, candidates: CaseRecord[] = []) {
  const reads: unknown[][] = [];
  const deps = {
    cases: {
      openCandidates: async (owner: Owner) => {
        reads.push(['openCandidates', owner]);
        return candidates;
      },
    },
    personalData: {
      storedObligations: async (owner: Owner, agentUserId: string | null, now: Date) => {
        reads.push(['storedObligations', owner, agentUserId, now]);
        return { ...NOTHING, ...stored };
      },
    },
    clock: { now: () => NOW },
  } as unknown as PrivacyDeps;
  return { useCase: new HasPendingObligationsUseCase(deps), reads };
}

const as = <T>(callerService: string | undefined, fn: () => Promise<T>) =>
  runWithContext({ correlationId: 'test', ...(callerService ? { callerService } : {}) }, fn);
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

describe('HasPendingObligationsUseCase (ksp.common.v1.ObligationService, ADR-036)', () => {
  it('contexte personnel : dossiers du compte, et ses affectations d’agent', async () => {
    const { useCase, reads } = setup();
    await expect(
      as('identity', () => useCase.execute({ userId: USER, organizationId: '' })),
    ).resolves.toEqual([]);
    const holder = { kind: 'user', id: USER };
    expect(reads).toEqual([
      ['openCandidates', holder],
      ['storedObligations', holder, USER, NOW],
    ]);
  });

  it('avec organizationId : dossiers de l’organisation, sans les affectations du compte', async () => {
    const { useCase, reads } = setup({ overdueInvoices: 2 });
    const obligations = await as('identity', () =>
      useCase.execute({ userId: USER.toUpperCase(), organizationId: ` ${ORGANIZATION} ` }),
    );
    const holder = { kind: 'organization', id: ORGANIZATION };
    expect(reads).toEqual([
      ['openCandidates', holder],
      ['storedObligations', holder, null, NOW],
    ]);
    expect(obligations.map((item) => item.kind)).toEqual(['unpaid_cleaning_invoice']);
  });

  it('demande ouverte d’après le statut effectif ; les autres natures viennent du dépôt', async () => {
    const { useCase } = setup(
      {
        programs: [{ number: 'PN-000003', status: 'in_progress', openSessions: 2 }],
        unpaidSessions: [{ programNumber: 'PN-000002', rank: 4 }],
        walletOperations: [{ subject: 'request', reference: 'DN-000009' }],
      },
      [
        caseRecord('DN-000001', 'visit_scheduled'),
        // Devis périmé, frais impayés à l'échéance : dossiers clos d'après l'heure (RV-14).
        caseRecord('DN-000002', 'quote_sent', { validUntil: new Date('2026-11-23T09:59:59Z') }),
        caseRecord('DN-000003', 'awaiting_visit_fee', { feeDueAt: NOW }),
        caseRecord('DN-000004', 'quote_sent', { validUntil: new Date('2026-11-23T10:00:01Z') }),
      ],
    );
    const obligations = await as('identity', () => useCase.execute({ userId: USER, organizationId: '' }));
    expect(obligations.map((item) => [item.kind, item.reference])).toEqual([
      ['open_cleaning_request', 'DN-000001'],
      ['open_cleaning_request', 'DN-000004'],
      ['open_cleaning_program', 'PN-000003'],
      ['unpaid_cleaning_session', 'PN-000002'],
      ['cleaning_payment_in_progress', 'DN-000009'],
    ]);
    // Jamais d'adresse, de position ni de montant : un numéro et une phrase.
    for (const item of obligations) {
      expect(Object.keys(item).sort()).toEqual(['description', 'kind', 'reference']);
      expect(item.description).not.toMatch(/FCFA|XOF|\d{4,}\s*F/);
    }
  });

  it('réservé à identity : tout autre service reçoit CLEANING_CALLER_FORBIDDEN, sans lecture', async () => {
    const { useCase, reads } = setup();
    for (const caller of ['gateway', 'wallet', 'billing', 'cleaning']) {
      expect(
        await failure(as(caller, () => useCase.execute({ userId: USER, organizationId: '' }))),
      ).toMatchObject({ kind: 'PERMISSION_DENIED', code: 'CLEANING_CALLER_FORBIDDEN' });
    }
    expect(reads).toEqual([]);
    // Sans vérificateur de jeton de service (développement local) : l'appelant est inconnu, l'appel passe.
    await expect(as(undefined, () => useCase.execute({ userId: USER }))).resolves.toEqual([]);
  });

  it('identifiants invalides : refusés avant toute lecture', async () => {
    const { useCase, reads } = setup();
    expect(await failure(as('identity', () => useCase.execute({ userId: '' })))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'userId', reason: 'required' },
    });
    expect(await failure(as('identity', () => useCase.execute({ userId: 'abc' })))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'userId', reason: 'invalid_type' },
    });
    expect(
      await failure(as('identity', () => useCase.execute({ userId: USER, organizationId: 'abc' }))),
    ).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'organizationId', reason: 'invalid_type' },
    });
    expect(reads).toEqual([]);
  });

  it('lecture en échec : une erreur, jamais « rien en cours »', async () => {
    const broken = (failing: 'cases' | 'personalData') =>
      new HasPendingObligationsUseCase({
        cases: {
          openCandidates: () =>
            failing === 'cases' ? Promise.reject(new Error('base injoignable')) : Promise.resolve([]),
        },
        personalData: {
          storedObligations: () =>
            failing === 'personalData'
              ? Promise.reject(new Error('délai dépassé'))
              : Promise.resolve(NOTHING),
        },
        clock: { now: () => NOW },
      } as unknown as PrivacyDeps);
    await expect(as('identity', () => broken('cases').execute({ userId: USER }))).rejects.toThrow(
      'base injoignable',
    );
    await expect(as('identity', () => broken('personalData').execute({ userId: USER }))).rejects.toThrow(
      'délai dépassé',
    );
  });
});
