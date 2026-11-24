import { type ObligationFacts, pendingObligations } from './obligations';

const NOW = new Date('2026-11-23T10:00:00Z');
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const NOTHING: ObligationFacts = {
  requests: [],
  programs: [],
  unpaidSessions: [],
  walletOperations: [],
  directPayments: [],
  overdueInvoices: 0,
  assignments: [],
};

const kinds = (facts: Partial<ObligationFacts>) =>
  pendingObligations({ ...NOTHING, ...facts }, NOW).map((item) => [item.kind, item.reference]);

describe('obligations qui bloquent la suppression d’un compte (partie 3, ADR-036)', () => {
  it('rien en cours : aucune obligation', () => {
    expect(pendingObligations(NOTHING, NOW)).toEqual([]);
  });

  it('demande ouverte : une obligation par dossier, d’après le statut effectif (RV-14)', () => {
    const obligations = pendingObligations(
      {
        ...NOTHING,
        requests: [
          { number: 'DN-000002', timeline: { status: 'visit_scheduled' } },
          { number: 'DN-000001', timeline: { status: 'awaiting_visit_fee', pendingVisitFeeDueAt: later(1) } },
          // Devis périmé et frais impayés à l'échéance : dossiers clos d'après l'heure.
          { number: 'DN-000003', timeline: { status: 'quote_sent', sentQuoteValidUntil: later(-1) } },
          { number: 'DN-000004', timeline: { status: 'awaiting_visit_fee', pendingVisitFeeDueAt: NOW } },
          { number: 'DN-000005', timeline: { status: 'accepted' } },
          { number: 'DN-000006', timeline: { status: 'cancelled' } },
        ],
      },
      NOW,
    );
    expect(obligations).toEqual([
      {
        kind: 'open_cleaning_request',
        reference: 'DN-000001',
        description: 'La demande de nettoyage DN-000001 est en cours : annulez-la ou attendez sa clôture.',
      },
      {
        kind: 'open_cleaning_request',
        reference: 'DN-000002',
        description: 'La demande de nettoyage DN-000002 est en cours : annulez-la ou attendez sa clôture.',
      },
    ]);
  });

  it('programme non terminé, ou terminé avec une séance encore à venir (repasse gratuite)', () => {
    const obligations = pendingObligations(
      {
        ...NOTHING,
        programs: [
          { number: 'PN-000001', status: 'confirmed', openSessions: 3 },
          { number: 'PN-000002', status: 'suspended', openSessions: 0 },
          { number: 'PN-000003', status: 'completed', openSessions: 0 },
          { number: 'PN-000004', status: 'cancelled', openSessions: 0 },
          { number: 'PN-000005', status: 'completed', openSessions: 1 },
        ],
      },
      NOW,
    );
    expect(obligations.map((item) => [item.kind, item.reference])).toEqual([
      ['open_cleaning_program', 'PN-000001'],
      ['open_cleaning_program', 'PN-000002'],
      ['open_cleaning_program', 'PN-000005'],
    ]);
    expect(obligations[0]?.description).toBe(
      "Le programme de nettoyage PN-000001 n'est pas terminé : arrêtez-le ou attendez sa fin.",
    );
  });

  it('séances à payer ou en retard : une obligation par programme, sans montant', () => {
    const obligations = pendingObligations(
      {
        ...NOTHING,
        unpaidSessions: [
          { programNumber: 'PN-000007', rank: 2 },
          { programNumber: 'PN-000003', rank: 1 },
          { programNumber: 'PN-000007', rank: 5 },
        ],
      },
      NOW,
    );
    expect(obligations).toEqual([
      {
        kind: 'unpaid_cleaning_session',
        reference: 'PN-000003',
        description: 'Une séance du programme PN-000003 reste à payer.',
      },
      {
        kind: 'unpaid_cleaning_session',
        reference: 'PN-000007',
        description: '2 séances du programme PN-000007 restent à payer.',
      },
    ]);
  });

  it('argent en cours : opération du wallet sans issue, page de paiement encore ouverte', () => {
    const obligations = pendingObligations(
      {
        ...NOTHING,
        walletOperations: [
          { subject: 'request', reference: 'DN-000010' },
          { subject: 'program', reference: 'PN-000010' },
          { subject: null, reference: null },
        ],
        directPayments: [
          // Même dossier qu'une opération en cours : une seule obligation.
          { subject: 'request', reference: 'DN-000010', createdAt: later(-1), expiresAt: later(2) },
          { subject: 'program', reference: 'PN-000011', createdAt: later(-1), expiresAt: later(2) },
          // Page expirée : plus rien ne peut être payé.
          { subject: 'program', reference: 'PN-000012', createdAt: later(-80), expiresAt: later(-8) },
          // Sans échéance connue : comptée pendant la durée de vie d'une page (72 h).
          { subject: 'program', reference: 'PN-000013', createdAt: later(-71), expiresAt: null },
          { subject: 'program', reference: 'PN-000014', createdAt: later(-72), expiresAt: null },
        ],
      },
      NOW,
    );
    expect(obligations).toEqual([
      {
        kind: 'cleaning_payment_in_progress',
        reference: '',
        description: "Un paiement de nettoyage est en cours : attendez qu'il aboutisse.",
      },
      {
        kind: 'cleaning_payment_in_progress',
        reference: 'DN-000010',
        description: "Un paiement est en cours pour la demande DN-000010 : attendez qu'il aboutisse.",
      },
      {
        kind: 'cleaning_payment_in_progress',
        reference: 'PN-000010',
        description: "Un paiement est en cours pour le programme PN-000010 : attendez qu'il aboutisse.",
      },
      {
        kind: 'cleaning_payment_in_progress',
        reference: 'PN-000011',
        description: "Un paiement est en cours pour le programme PN-000011 : attendez qu'il aboutisse.",
      },
      {
        kind: 'cleaning_payment_in_progress',
        reference: 'PN-000013',
        description: "Un paiement est en cours pour le programme PN-000013 : attendez qu'il aboutisse.",
      },
    ]);
  });

  it('organisation : factures mensuelles impayées suivies par cleaning', () => {
    expect(pendingObligations({ ...NOTHING, overdueInvoices: 1 }, NOW)).toEqual([
      {
        kind: 'unpaid_cleaning_invoice',
        reference: '',
        description: "Une facture mensuelle de nettoyage de l'organisation est impayée.",
      },
    ]);
    expect(pendingObligations({ ...NOTHING, overdueInvoices: 3 }, NOW)[0]?.description).toBe(
      "3 factures mensuelles de nettoyage de l'organisation sont impayées.",
    );
  });

  it('agent : une affectation à venir, en cours comprise, bloque (R-AG-03)', () => {
    const confirmed = { status: 'confirmed' as const, respondBefore: null };
    const obligations = pendingObligations(
      {
        ...NOTHING,
        assignments: [
          { ...confirmed, target: 'session', reference: 'PN-000020', end: later(30) },
          { ...confirmed, target: 'session', reference: 'PN-000020', end: later(54) },
          // En cours : la fin est après maintenant.
          { ...confirmed, target: 'visit', reference: 'DN-000020', end: later(1) },
          // Terminée, retirée, ou sans réponse dans le délai : n'attend plus l'agent.
          { ...confirmed, target: 'session', reference: 'PN-000021', end: NOW },
          {
            status: 'removed',
            respondBefore: null,
            target: 'session',
            reference: 'PN-000022',
            end: later(9),
          },
          {
            status: 'pending_confirmation',
            respondBefore: later(-1),
            target: 'session',
            reference: 'PN-000023',
            end: later(9),
          },
          {
            status: 'pending_confirmation',
            respondBefore: later(1),
            target: 'visit',
            reference: 'DN-000024',
            end: later(9),
          },
          {
            status: 'proposed',
            respondBefore: null,
            target: 'session',
            reference: 'PN-000025',
            end: later(9),
          },
        ],
      },
      NOW,
    );
    expect(obligations).toEqual([
      {
        kind: 'upcoming_cleaning_assignment',
        reference: 'DN-000020',
        description:
          "Vous êtes attendu sur une visite de la demande DN-000020 : demandez d'abord votre remplacement.",
      },
      {
        kind: 'upcoming_cleaning_assignment',
        reference: 'DN-000024',
        description:
          "Vous êtes attendu sur une visite de la demande DN-000024 : demandez d'abord votre remplacement.",
      },
      {
        kind: 'upcoming_cleaning_assignment',
        reference: 'PN-000020',
        description:
          "Vous êtes attendu sur 2 séances du programme PN-000020 : demandez d'abord votre remplacement.",
      },
      {
        kind: 'upcoming_cleaning_assignment',
        reference: 'PN-000025',
        description:
          "Vous êtes attendu sur une séance du programme PN-000025 : demandez d'abord votre remplacement.",
      },
    ]);
  });

  it('ordre stable : demandes, programmes, séances impayées, paiements, factures, affectations', () => {
    expect(
      kinds({
        assignments: [
          {
            status: 'confirmed',
            respondBefore: null,
            target: 'session',
            reference: 'PN-000001',
            end: later(2),
          },
        ],
        overdueInvoices: 2,
        directPayments: [{ subject: 'request', reference: 'DN-000001', createdAt: NOW, expiresAt: null }],
        unpaidSessions: [{ programNumber: 'PN-000001', rank: 1 }],
        programs: [{ number: 'PN-000001', status: 'in_progress', openSessions: 1 }],
        requests: [{ number: 'DN-000001', timeline: { status: 'visit_done' } }],
      }),
    ).toEqual([
      ['open_cleaning_request', 'DN-000001'],
      ['open_cleaning_program', 'PN-000001'],
      ['unpaid_cleaning_session', 'PN-000001'],
      ['cleaning_payment_in_progress', 'DN-000001'],
      ['unpaid_cleaning_invoice', ''],
      ['upcoming_cleaning_assignment', 'PN-000001'],
    ]);
  });
});
