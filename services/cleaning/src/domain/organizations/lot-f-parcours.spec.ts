import { hasResumedProgram, type OrganizationProgram, type ProgramChange } from './alignment';
import { reactToUnpaidCount } from './react';
import {
  countOverdue,
  DEFAULT_UNPAID_THRESHOLDS,
  type InvoiceStanding,
  isTrackedInvoice,
  nextInvoiceStanding,
  type OrganizationBillingStanding,
} from './standing';

/**
 * Critère du lot F, côté cleaning (domaine) : facture du mois 1 payée, mois 2 et 3 impayées →
 * avertissement puis suspension de tous les programmes de l'organisation ; paiement → reprise et
 * réaffectation des séances (à affecter, ou date de rattrapage proposée). Les changements rendus
 * par le domaine sont appliqués ici à des programmes en mémoire, comme le fera le dépôt.
 */
const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const ORG = 'org-1';
const resume = { firstSessionLeadHours: 48, excludedDays: () => new Set<string>(), maxWeeks: 8 };

function session(
  id: string,
  rank: number,
  status: OrganizationProgram['sessions'][number]['status'],
  start: string,
  agentIds: string[] = [],
) {
  const scheduledStart = at(start);
  return {
    id,
    rank,
    status,
    scheduledStart,
    scheduledEnd: new Date(scheduledStart.getTime() + 3 * HOUR),
    agentIds,
  };
}

describe('lot F — scénario de 3 mois d’une organisation (R-PE-06, R-SU-01 à R-SU-03)', () => {
  let programs: OrganizationProgram[];
  let standing: OrganizationBillingStanding;
  const invoices = new Map<string, InvoiceStanding>();
  const warnings: number[] = [];
  const history: ProgramChange[][] = [];

  /** Applique les changements rendus par le domaine, comme le dépôt le fera en transaction. */
  function apply(changes: readonly ProgramChange[]): void {
    for (const change of changes) {
      programs = programs.map((program) => {
        if (program.id !== change.programId) return program;
        let sessions = program.sessions;
        if (change.effect === 'suspended') {
          sessions = sessions.map((s) =>
            change.suspendedSessionIds.includes(s.id)
              ? { ...s, status: 'suspended' as const, agentIds: [] }
              : s,
          );
        }
        if (change.effect === 'resumed') {
          sessions = sessions.map((s) =>
            change.resumption.toAssign.includes(s.id) ? { ...s, status: 'to_assign' as const } : s,
          );
        }
        return { ...program, ...change.program, sessions };
      });
    }
  }

  /** Facture mensuelle reçue de billing (overdue ou paid, v2), puis réaction de cleaning. */
  function receive(invoiceId: string, event: 'overdue' | 'paid', now: Date) {
    const payload = { source: 'cleaning', kind: 'monthly', organizationId: ORG };
    if (!isTrackedInvoice(payload)) return null;
    invoices.set(invoiceId, nextInvoiceStanding(invoices.get(invoiceId) ?? null, event));
    const overdueInvoiceIds = [...invoices].filter(([, s]) => s === 'overdue').map(([id]) => id);
    const result = reactToUnpaidCount({
      standing,
      overdueInvoiceIds,
      thresholds: DEFAULT_UNPAID_THRESHOLDS,
      programs,
      now,
      resume,
    });
    standing = result.standing;
    if (result.warning) warnings.push(result.warning.unpaidCount);
    apply(result.changes);
    history.push(result.changes);
    return result;
  }

  beforeAll(() => {
    standing = { organizationId: ORG, overdueCount: 0, warningLevel: 0, version: 0 };
    programs = [
      {
        id: 'p1',
        status: 'in_progress',
        causes: [],
        suspendedAt: null,
        sessions: [
          session('s1', 1, 'completed', '2026-11-10T08:00:00Z'),
          session('s2', 2, 'completed', '2026-12-10T08:00:00Z'),
          session('s3', 3, 'in_progress', '2027-02-11T22:00:00Z', ['agent-1']),
          session('s4', 4, 'assigned', '2027-02-14T08:00:00Z', ['agent-1', 'agent-2']),
          session('s5', 5, 'assigned', '2027-03-10T08:00:00Z', ['agent-3']),
        ],
      },
      {
        id: 'p2',
        status: 'confirmed',
        causes: [],
        suspendedAt: null,
        sessions: [session('t1', 1, 'to_assign', '2027-03-01T08:00:00Z')],
      },
      {
        id: 'p3',
        status: 'suspended',
        causes: [
          {
            cause: 'ksp_decision',
            since: at('2027-01-20T10:00:00Z'),
            reason: 'Litige',
            decidedBy: 'admin-1',
          },
        ],
        suspendedAt: at('2027-01-20T10:00:00Z'),
        sessions: [session('u1', 1, 'suspended', '2027-03-05T08:00:00Z')],
      },
    ];
  });

  it('mois 1 : facture de novembre payée, rien ne change', () => {
    const result = receive('inv-nov', 'paid', at('2026-12-05T10:00:00Z'));
    expect(result?.changes).toEqual([]);
    expect(result?.warning).toBeNull();
    expect(standing).toMatchObject({ overdueCount: 0, warningLevel: 0 });
  });

  it('mois 2 : décembre impayée → avertissement (1 impayée), aucun programme suspendu', () => {
    const result = receive('inv-dec', 'overdue', at('2027-01-11T23:00:00Z'));
    expect(result?.changes).toEqual([]);
    expect(result?.warning).toMatchObject({ unpaidCount: 1, warningThreshold: 1, suspensionThreshold: 2 });
    expect(result?.warning?.overdueInvoiceIds).toEqual(['inv-dec']);
    expect(standing).toMatchObject({ overdueCount: 1, warningLevel: 1 });
  });

  it('événement rejoué au même niveau : pas de second avertissement', () => {
    receive('inv-dec', 'overdue', at('2027-01-12T09:00:00Z'));
    expect(warnings).toEqual([1]);
  });

  it('mois 3 : janvier impayée → 2 impayées, tous les programmes suspendus', () => {
    const now = at('2027-02-11T23:00:00Z');
    const result = receive('inv-jan', 'overdue', now)!;
    expect(result.warning).toBeNull();
    expect(standing).toMatchObject({ overdueCount: 2, warningLevel: 1 });
    expect(result.changes).toEqual([
      expect.objectContaining({
        programId: 'p1',
        effect: 'suspended',
        causes: ['unpaid_invoices'],
        // R-SU-02 : séances à venir gelées, agents libérés ; la séance en cours continue.
        suspendedSessionIds: ['s4', 's5'],
        releasedAgentIds: ['agent-1', 'agent-2', 'agent-3'],
      }),
      expect.objectContaining({ programId: 'p2', effect: 'suspended', suspendedSessionIds: ['t1'] }),
      // Programme déjà suspendu par KSP : la cause s'ajoute (suspension_updated, RV-84).
      expect.objectContaining({
        programId: 'p3',
        effect: 'cause_added',
        causes: ['ksp_decision', 'unpaid_invoices'],
      }),
    ]);
    expect(programs.map((p) => p.status)).toEqual(['suspended', 'suspended', 'suspended']);
    expect(programs[0]!.sessions.find((s) => s.id === 's3')?.status).toBe('in_progress');
  });

  it('paiement de décembre → 1 impayée : reprise et réaffectation ; p3 reste suspendu par KSP', () => {
    const now = at('2027-02-20T10:00:00Z');
    const result = receive('inv-dec', 'paid', now)!;
    expect(hasResumedProgram(result.changes)).toBe(true);
    const [p1, p2, p3] = result.changes;
    expect(p1).toMatchObject({
      programId: 'p1',
      effect: 'resumed',
      liftedCause: 'unpaid_invoices',
      program: { status: 'in_progress', causes: [], suspendedAt: null },
      resumption: {
        // R-SU-03 : après maintenant + 48 h → à affecter (la planification cherche des agents).
        toAssign: ['s5'],
        // Séance passée pendant la suspension : même jour et même heure, N semaines plus tard.
        catchUp: [
          {
            sessionId: 's4',
            rank: 4,
            previousStart: at('2027-02-14T08:00:00Z'),
            suggestedStart: at('2027-02-28T08:00:00Z'),
          },
        ],
      },
    });
    expect(p2).toMatchObject({ programId: 'p2', effect: 'resumed', program: { status: 'confirmed' } });
    expect(p3).toMatchObject({ programId: 'p3', effect: 'cause_lifted', causes: ['ksp_decision'] });
    // Réévaluation à la reprise : 1 impayée, niveau déjà averti à 1 → pas de nouvel avertissement.
    expect(result.warning).toBeNull();
    expect(programs[0]!.sessions.find((s) => s.id === 's5')?.status).toBe('to_assign');
    expect(programs.map((p) => p.status)).toEqual(['in_progress', 'confirmed', 'suspended']);
  });

  it('paiement de janvier → 0 impayée : niveau redescendu, plus rien à lever', () => {
    const result = receive('inv-jan', 'paid', at('2027-02-20T11:00:00Z'))!;
    expect(result.changes).toEqual([]);
    expect(standing).toMatchObject({ overdueCount: 0, warningLevel: 0 });
    expect(countOverdue([...invoices.values()].map((s) => ({ standing: s })))).toBe(0);
    // Un « impayée » arrivé en retard ne fait pas revenir une facture soldée.
    receive('inv-jan', 'overdue', at('2027-02-20T12:00:00Z'));
    expect(standing.overdueCount).toBe(0);
    expect(warnings).toEqual([1]);
    expect(history.flat().filter((c) => c.effect === 'suspended')).toHaveLength(2);
  });
});
