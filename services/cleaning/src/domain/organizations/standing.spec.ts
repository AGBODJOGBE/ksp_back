import {
  countOverdue,
  decideOrganizationStanding,
  DEFAULT_UNPAID_THRESHOLDS,
  isTrackedInvoice,
  nextInvoiceStanding,
  type StandingProgram,
  unpaidThresholdsProblems,
  unpaidWarningPayload,
  withDecision,
} from './standing';

const running = (id: string): StandingProgram => ({ id, status: 'in_progress', causes: [] });
const decide = (overdueCount: number, warningLevel: number, programs: StandingProgram[]) =>
  decideOrganizationStanding({ overdueCount, warningLevel, thresholds: DEFAULT_UNPAID_THRESHOLDS, programs });

describe('seuils d’impayés (16.1 : 1 / 2, bornes 1 à 12, avertissement < suspension)', () => {
  it('valeurs par défaut valides ; bornes et règle croisée', () => {
    expect(unpaidThresholdsProblems(DEFAULT_UNPAID_THRESHOLDS)).toEqual([]);
    expect(unpaidThresholdsProblems({ warning: 0, suspension: 2 })).toEqual(['unpaidInvoicesWarning']);
    expect(unpaidThresholdsProblems({ warning: 1, suspension: 13 })).toEqual(['unpaidInvoicesSuspension']);
    expect(unpaidThresholdsProblems({ warning: 2, suspension: 2 })).toEqual(['unpaidInvoicesWarning']);
    expect(unpaidThresholdsProblems({ warning: 1.5, suspension: 3 })).toEqual(['unpaidInvoicesWarning']);
  });
});

describe('factures suivies par cleaning (RV-87)', () => {
  it('seules les factures mensuelles d’organisation du Nettoyage', () => {
    expect(isTrackedInvoice({ source: 'cleaning', kind: 'monthly', organizationId: 'o1' })).toBe(true);
    expect(isTrackedInvoice({ source: 'cleaning', kind: 'session', organizationId: 'o1' })).toBe(false);
    expect(isTrackedInvoice({ source: 'cleaning', kind: 'monthly', organizationId: null })).toBe(false);
    expect(isTrackedInvoice({ source: 'cleaning', organizationId: 'o1' })).toBe(false);
    expect(isTrackedInvoice({ source: 'other', kind: 'monthly', organizationId: 'o1' })).toBe(false);
  });

  it('une facture soldée ne redevient jamais impayée, quel que soit l’ordre d’arrivée', () => {
    expect(nextInvoiceStanding(null, 'overdue')).toBe('overdue');
    expect(nextInvoiceStanding('overdue', 'paid')).toBe('paid');
    expect(nextInvoiceStanding(null, 'paid')).toBe('paid');
    expect(nextInvoiceStanding('paid', 'overdue')).toBe('paid');
    expect(countOverdue([{ standing: 'overdue' }, { standing: 'paid' }, { standing: 'overdue' }])).toBe(2);
  });
});

describe('décision (R-PE-06, RV-83)', () => {
  it('1 impayée : avertissement, niveau 1 ; pas deux fois au même niveau', () => {
    expect(decide(1, 0, [running('p1')])).toEqual({
      addCause: [],
      liftCause: [],
      warn: true,
      warningLevel: 1,
    });
    expect(decide(1, 1, [running('p1')])).toMatchObject({ warn: false, warningLevel: 1 });
  });

  it('2 impayées : tous les programmes non terminés suspendus, sans avertissement', () => {
    const programs: StandingProgram[] = [
      running('p1'),
      { id: 'p2', status: 'confirmed', causes: [] },
      { id: 'p3', status: 'completed', causes: [] },
      { id: 'p4', status: 'suspended', causes: [{ cause: 'unpaid_invoices' }] },
    ];
    expect(decide(2, 1, programs)).toEqual({
      addCause: ['p1', 'p2'],
      liftCause: [],
      warn: false,
      warningLevel: 1,
    });
  });

  it('repasser sous le seuil lève la cause ; le niveau redescend avec le nombre', () => {
    const suspended: StandingProgram = {
      id: 'p1',
      status: 'suspended',
      causes: [{ cause: 'unpaid_invoices' }],
    };
    expect(decide(1, 1, [suspended])).toEqual({
      addCause: [],
      liftCause: ['p1'],
      warn: false,
      warningLevel: 1,
    });
    expect(decide(0, 1, [suspended])).toEqual({
      addCause: [],
      liftCause: ['p1'],
      warn: false,
      warningLevel: 0,
    });
  });

  it('pas d’avertissement pendant une suspension ; réévalué à la reprise', () => {
    const organizationSuspended: StandingProgram = {
      id: 'p1',
      status: 'suspended',
      causes: [{ cause: 'organization_suspended' }],
    };
    expect(decide(1, 0, [organizationSuspended])).toMatchObject({ warn: false, warningLevel: 0 });
    // Reprise (organisation réactivée) : la situation est réévaluée, l’avertissement part.
    expect(decide(1, 0, [running('p1')])).toMatchObject({ warn: true, warningLevel: 1 });
  });

  it('un seul programme suspendu sur deux : l’avertissement part', () => {
    const programs: StandingProgram[] = [
      { id: 'p1', status: 'suspended', causes: [{ cause: 'ksp_decision' }] },
      running('p2'),
    ];
    expect(decide(1, 0, programs).warn).toBe(true);
  });

  it('organisation sans programme en cours : avertie (interprétation) ; au seuil, rien à suspendre', () => {
    expect(decide(1, 0, [])).toMatchObject({ warn: true, addCause: [] });
    expect(decide(3, 1, [{ id: 'p1', status: 'cancelled', causes: [] }])).toMatchObject({
      warn: true,
      warningLevel: 3,
    });
  });

  it('0 impayée : rien', () => {
    expect(decide(0, 0, [running('p1')])).toEqual({
      addCause: [],
      liftCause: [],
      warn: false,
      warningLevel: 0,
    });
  });
});

describe('situation et événement d’avertissement', () => {
  it('compte, niveau et version suivante', () => {
    const standing = { organizationId: 'o1', overdueCount: 0, warningLevel: 0, version: 3 };
    expect(withDecision(standing, 1, { warningLevel: 1 })).toEqual({
      organizationId: 'o1',
      overdueCount: 1,
      warningLevel: 1,
      version: 4,
    });
  });

  it('cleaning.organization.unpaid_warning : identifiants seulement, factures triées', () => {
    expect(
      unpaidWarningPayload({
        organizationId: 'o1',
        overdueCount: 1,
        thresholds: DEFAULT_UNPAID_THRESHOLDS,
        overdueInvoiceIds: ['i2', 'i1'],
        now: new Date('2027-01-12T00:00:00Z'),
      }),
    ).toEqual({
      organizationId: 'o1',
      unpaidCount: 1,
      warningThreshold: 1,
      suspensionThreshold: 2,
      overdueInvoiceIds: ['i1', 'i2'],
      warnedAt: '2027-01-12T00:00:00.000Z',
    });
  });
});
