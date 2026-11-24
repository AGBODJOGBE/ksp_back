import { type OrganizationDeps } from '../deps';
import { FakeOrganizations, programRecord, sessionRecord } from '../testing/organization-fakes';
import {
  INVOICE_OVERDUE_CONSUMER,
  OrganizationStandingUseCases,
  StandingSettings,
} from './standing.use-cases';

/**
 * Situation des organisations (piste O ; critère du lot F côté application) : les événements de
 * billing et d'identity sont traités sur une base en mémoire, les programmes écrits par le vrai
 * code de suspension et de reprise du lot E.
 */
const at = (iso: string) => new Date(iso);
const uuid = (suffix: string) => `0196b1c0-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG = uuid('a1');
const OTHER_ORG = uuid('a2');
const [P0, P1, P2, P3] = [uuid('b0'), uuid('b1'), uuid('b2'), uuid('b3')];
const [A1, A2, A3] = [uuid('c1'), uuid('c2'), uuid('c3')];
const [JANUARY, FEBRUARY, MARCH] = [uuid('f1'), uuid('f2'), uuid('f3')];

function setup() {
  const organizations = new FakeOrganizations();
  const clock = { time: at('2026-02-10T08:00:00.000Z'), now: (): Date => clock.time };
  const reported: string[] = [];
  const useCases = new OrganizationStandingUseCases(
    {
      organizations,
      execution: organizations.reader,
      moduleSettings: organizations.moduleSettings,
      clock,
    } as unknown as OrganizationDeps,
    (organizationId) => reported.push(organizationId),
  );
  let sequence = 0;
  const invoice = (event: 'overdue' | 'paid', invoiceId: string, organizationId: string | null = ORG) =>
    useCases.onInvoiceEvent({
      eventId: uuid(`e${(sequence += 1)}`),
      event,
      invoiceId,
      organizationId,
      source: 'cleaning',
      kind: 'monthly',
    });
  const decision = (kind: 'suspended' | 'reactivated', occurredAt: string, organizationId = ORG) =>
    useCases.onOrganizationDecision({
      eventId: uuid(`e${(sequence += 1)}`),
      decision: kind,
      organizationId,
      occurredAt: at(occurredAt),
    });
  const events = (type: string) => organizations.state.events.filter((event) => event.type === type);
  const program = (id: string) => organizations.state.programs.get(id)!;
  const session = (programId: string, id: string) =>
    organizations.state.sessions.get(programId)!.find((line) => line.id === id)!;
  return { organizations, clock, useCases, invoice, decision, events, program, session, reported };
}

/** Trois programmes : deux actifs avec des séances, un déjà suspendu par décision de KSP. */
function seedPrograms(organizations: FakeOrganizations, organizationId = ORG) {
  const { programs, sessions } = organizations.state;
  programs.set(P1, programRecord({ id: P1, organizationId }));
  sessions.set(P1, [
    sessionRecord({
      id: uuid('11'),
      programId: P1,
      rank: 1,
      status: 'completed',
      start: at('2026-02-23T09:00:00Z'),
    }),
    sessionRecord({
      id: uuid('12'),
      programId: P1,
      rank: 2,
      status: 'assigned',
      start: at('2026-03-03T09:00:00Z'),
      agentIds: [A1, A2],
    }),
    sessionRecord({
      id: uuid('13'),
      programId: P1,
      rank: 3,
      status: 'to_assign',
      start: at('2026-03-24T09:00:00Z'),
    }),
  ]);
  programs.set(P2, programRecord({ id: P2, organizationId, status: 'in_progress' }));
  sessions.set(P2, [
    sessionRecord({
      id: uuid('21'),
      programId: P2,
      rank: 1,
      status: 'in_progress',
      start: at('2026-03-02T07:00:00Z'),
      agentIds: [A3],
    }),
    sessionRecord({
      id: uuid('22'),
      programId: P2,
      rank: 2,
      status: 'assigned',
      start: at('2026-03-17T09:00:00Z'),
      agentIds: [A3],
    }),
  ]);
  programs.set(
    P3,
    programRecord({
      id: P3,
      organizationId,
      causes: [
        {
          cause: 'ksp_decision',
          since: at('2026-02-01T08:00:00Z'),
          reason: 'Contrôle',
          decidedBy: uuid('d1'),
        },
      ],
    }),
  );
  sessions.set(P3, [
    sessionRecord({
      id: uuid('31'),
      programId: P3,
      rank: 1,
      status: 'suspended',
      start: at('2026-03-05T09:00:00Z'),
    }),
  ]);
}

describe('Factures mensuelles impayées (R-PE-06, UC-NT-47)', () => {
  it('mois 1 payé, mois 2 impayé → avertissement, mois 3 impayé → suspension, paiement → reprise', async () => {
    const { organizations, clock, invoice, events, program, session } = setup();
    seedPrograms(organizations);

    // Mois 1 : payé sans jamais avoir été impayé.
    expect(await invoice('paid', JANUARY)).toMatchObject({
      status: 'processed',
      unpaidCount: 0,
      warned: false,
    });
    expect(organizations.state.events).toHaveLength(0);

    // Mois 2 impayé : avertissement, aucun programme touché.
    clock.time = at('2026-02-20T08:00:00.000Z');
    expect(await invoice('overdue', FEBRUARY)).toMatchObject({
      status: 'processed',
      unpaidCount: 1,
      warned: true,
    });
    expect(events('cleaning.organization.unpaid_warning').map((event) => event.payload)).toEqual([
      {
        organizationId: ORG,
        unpaidCount: 1,
        warningThreshold: 1,
        suspensionThreshold: 2,
        overdueInvoiceIds: [FEBRUARY],
        warnedAt: '2026-02-20T08:00:00.000Z',
      },
    ]);
    expect(organizations.state.audit.map((entry) => [entry.actorId, entry.action, entry.entityId])).toEqual([
      ['system', 'organization.unpaid_warning', ORG],
    ]);
    expect(program(P1).status).toBe('confirmed');
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 1, warningLevel: 1 });

    // Mois 3 impayé : tous les programmes suspendus, séances à venir gelées, agents libérés.
    clock.time = at('2026-03-02T08:00:00.000Z');
    expect(await invoice('overdue', MARCH)).toMatchObject({
      status: 'processed',
      unpaidCount: 2,
      warned: false,
      suspended: 2,
      updated: 1,
    });
    expect(program(P1)).toMatchObject({ status: 'suspended', suspendedAt: clock.time });
    expect(program(P1).causes.map((cause) => cause.cause)).toEqual(['unpaid_invoices']);
    expect(session(P1, uuid('12'))).toMatchObject({ status: 'suspended', agents: [] });
    expect(session(P1, uuid('13')).status).toBe('suspended');
    expect(session(P1, uuid('11')).status).toBe('completed');
    // Une séance en cours n'est pas interrompue (R-SU-02).
    expect(session(P2, uuid('21'))).toMatchObject({ status: 'in_progress', agents: [{ agentId: A3 }] });
    expect(session(P2, uuid('22')).status).toBe('suspended');
    expect(events('cleaning.program.suspended').map((event) => event.payload)).toEqual([
      expect.objectContaining({
        programId: P1,
        organizationId: ORG,
        causes: ['unpaid_invoices'],
        suspendedSessionIds: [uuid('12'), uuid('13')],
        releasedAgentIds: [A1, A2],
        unpaidCount: 2,
        overdueCount: null,
        threshold: 2,
      }),
      expect.objectContaining({ programId: P2, suspendedSessionIds: [uuid('22')], releasedAgentIds: [A3] }),
    ]);
    // Programme déjà suspendu par KSP : la cause s'ajoute, sans nouvelle suspension (RV-84).
    expect(program(P3).causes.map((cause) => cause.cause)).toEqual(['ksp_decision', 'unpaid_invoices']);
    expect(events('cleaning.program.suspension_updated').map((event) => event.payload)).toEqual([
      expect.objectContaining({
        programId: P3,
        change: 'cause_added',
        cause: 'unpaid_invoices',
        causes: ['ksp_decision', 'unpaid_invoices'],
        unpaidCount: 2,
      }),
    ]);
    // Pas d'avertissement pendant une suspension.
    expect(events('cleaning.organization.unpaid_warning')).toHaveLength(1);
    expect(
      organizations.state.audit
        .filter((entry) => entry.action.startsWith('program.'))
        .map((entry) => entry.action),
    ).toEqual(['program.suspended', 'program.suspended', 'program.cause_added']);
    expect(organizations.state.audit.every((entry) => entry.actorId === 'system')).toBe(true);

    // Paiement du mois 2 : reprise, séances à réaffecter et rattrapage.
    clock.time = at('2026-03-09T08:00:00.000Z');
    expect(await invoice('paid', FEBRUARY)).toMatchObject({
      status: 'processed',
      unpaidCount: 1,
      warned: false,
      resumed: 2,
      updated: 1,
    });
    expect(program(P1)).toMatchObject({ status: 'in_progress', causes: [], suspendedAt: null });
    expect(program(P2)).toMatchObject({ status: 'in_progress', causes: [] });
    // Séance dont la date est passée : rattrapage proposé, même jour et même heure plus tard.
    expect(session(P1, uuid('12'))).toMatchObject({
      status: 'suspended',
      catchUpSuggestedStart: at('2026-03-17T09:00:00.000Z'),
    });
    expect(session(P1, uuid('13')).status).toBe('to_assign');
    expect(session(P2, uuid('22')).status).toBe('to_assign');
    expect(events('cleaning.program.resumed').map((event) => event.payload)).toEqual([
      expect.objectContaining({
        programId: P1,
        sessionsToAssign: 1,
        catchUpSessionIds: [uuid('12')],
        liftedCause: 'unpaid_invoices',
        resumedAt: '2026-03-09T08:00:00.000Z',
      }),
      expect.objectContaining({ programId: P2, sessionsToAssign: 1, catchUpSessionIds: [] }),
    ]);
    // Cumul des causes : le programme suspendu par KSP le reste après le paiement.
    expect(program(P3)).toMatchObject({ status: 'suspended' });
    expect(program(P3).causes.map((cause) => cause.cause)).toEqual(['ksp_decision']);
    expect(events('cleaning.program.suspension_updated').at(-1)!.payload).toMatchObject({
      programId: P3,
      change: 'cause_lifted',
      cause: 'unpaid_invoices',
      causes: ['ksp_decision'],
      unpaidCount: 1,
    });
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 1, warningLevel: 1 });
    expect(organizations.state.causes.filter((line) => line.cause === 'unpaid_invoices')).toHaveLength(3);
    expect(
      organizations.state.causes.every((line) => line.cause !== 'unpaid_invoices' || line.liftedAt),
    ).toBe(true);
  });

  it('un événement rejoué ne change rien', async () => {
    const { organizations, useCases, invoice } = setup();
    seedPrograms(organizations);
    await invoice('overdue', FEBRUARY);
    const replayed = {
      eventId: uuid('e99'),
      event: 'overdue' as const,
      invoiceId: MARCH,
      organizationId: ORG,
      source: 'cleaning',
      kind: 'monthly',
    };
    expect(await useCases.onInvoiceEvent(replayed)).toMatchObject({ status: 'processed', suspended: 2 });
    const before = structuredClone(organizations.state);
    expect(await useCases.onInvoiceEvent(replayed)).toEqual({ status: 'duplicate' });
    expect(organizations.state).toEqual(before);
    expect(organizations.state.processed.has(`${replayed.eventId}|${INVOICE_OVERDUE_CONSUMER}`)).toBe(true);
  });

  it('une facture soldée ne redevient jamais impayée, même si « impayée » arrive en retard', async () => {
    const { organizations, invoice, events } = setup();
    seedPrograms(organizations);
    await invoice('paid', JANUARY);
    expect(await invoice('overdue', JANUARY)).toMatchObject({
      status: 'processed',
      unpaidCount: 0,
      warned: false,
    });
    expect(organizations.state.invoices.get(JANUARY)!.standing).toBe('paid');
    expect(events('cleaning.organization.unpaid_warning')).toHaveLength(0);
    expect(organizations.state.billing.has(ORG)).toBe(false);
  });

  it('ignore les factures qui ne sont pas des factures mensuelles d’organisation du Nettoyage', async () => {
    const { organizations, useCases } = setup();
    const base = { eventId: uuid('e1'), event: 'overdue' as const, invoiceId: MARCH, source: 'cleaning' };
    expect(await useCases.onInvoiceEvent({ ...base, organizationId: ORG, kind: 'session' })).toEqual({
      status: 'ignored',
    });
    expect(await useCases.onInvoiceEvent({ ...base, organizationId: null, kind: 'monthly' })).toEqual({
      status: 'ignored',
    });
    // Événement v1 : pas de `kind`.
    expect(await useCases.onInvoiceEvent({ ...base, organizationId: ORG })).toEqual({ status: 'ignored' });
    expect(organizations.trace).toHaveLength(0);
    expect(organizations.state.processed.size).toBe(0);
  });

  it('avertit une fois par nombre d’impayés, et de nouveau quand le nombre remonte', async () => {
    const { organizations, invoice, events } = setup();
    const warnedCounts = () =>
      events('cleaning.organization.unpaid_warning').map(
        (event) => (event.payload as { unpaidCount: number }).unpaidCount,
      );
    organizations.settings = { ...organizations.settings, unpaidInvoicesSuspension: 4 };
    seedPrograms(organizations);
    await invoice('overdue', JANUARY);
    await invoice('overdue', FEBRUARY);
    expect(warnedCounts()).toEqual([1, 2]);
    await invoice('paid', FEBRUARY);
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 1, warningLevel: 1 });
    await invoice('overdue', MARCH);
    expect(warnedCounts()).toEqual([1, 2, 2]);
  });

  it('annule tout si la transaction échoue : l’événement pourra être rejoué', async () => {
    const { organizations, useCases } = setup();
    seedPrograms(organizations);
    const event = {
      eventId: uuid('e1'),
      event: 'overdue' as const,
      invoiceId: FEBRUARY,
      organizationId: ORG,
      source: 'cleaning',
      kind: 'monthly',
    };
    organizations.failing.add(ORG);
    await expect(useCases.onInvoiceEvent(event)).rejects.toThrow('Échec de la transaction');
    expect(organizations.state.processed.size).toBe(0);
    expect(organizations.state.invoices.size).toBe(0);
    expect(organizations.state.events).toHaveLength(0);
    expect(await useCases.onInvoiceEvent(event)).toMatchObject({ status: 'processed', warned: true });
  });

  it('deux événements simultanés de la même organisation passent l’un après l’autre', async () => {
    const { organizations, invoice, events, program } = setup();
    seedPrograms(organizations);
    const outcomes = await Promise.all([invoice('overdue', FEBRUARY), invoice('overdue', MARCH)]);
    expect(organizations.trace).toEqual([`début ${ORG}`, `fin ${ORG}`, `début ${ORG}`, `fin ${ORG}`]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['processed', 'processed']);
    expect(events('cleaning.organization.unpaid_warning')).toHaveLength(1);
    expect(events('cleaning.program.suspended')).toHaveLength(2);
    expect(program(P1).status).toBe('suspended');
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 2, version: 2 });
  });

  it('prend les verrous des programmes dans l’ordre de leurs identifiants', async () => {
    const { organizations, invoice } = setup();
    seedPrograms(organizations);
    // Programme créé après les autres, d'identifiant plus petit.
    organizations.state.programs.set(P0, programRecord({ id: P0, organizationId: ORG }));
    organizations.state.sessions.set(P0, []);
    const locked: string[][] = [];
    const run = organizations.run.bind(organizations);
    organizations.run = (organizationId, work) =>
      run(organizationId, async (tx) => {
        const result = await work(tx);
        locked.push((tx as unknown as { execution: { locked: string[] } }).execution.locked);
        return result;
      });
    await invoice('overdue', FEBRUARY);
    expect(locked[0]!.slice(0, 5)).toEqual([`organisation ${ORG}`, P0, P1, P2, P3]);
  });
});

describe('Suspension d’une organisation par KSP (RV-85)', () => {
  it('pose la cause à la suspension, la lève à la réactivation, ignore un événement plus ancien', async () => {
    const { organizations, clock, decision, events, program, session } = setup();
    seedPrograms(organizations);
    clock.time = at('2026-03-02T08:00:00.000Z');

    expect(await decision('suspended', '2026-03-02T07:59:00.000Z')).toMatchObject({
      status: 'processed',
      suspended: 2,
      updated: 1,
    });
    expect(organizations.state.ksp.get(ORG)).toEqual({
      organizationId: ORG,
      suspended: true,
      changedAt: at('2026-03-02T07:59:00.000Z'),
    });
    expect(program(P1).causes.map((cause) => cause.cause)).toEqual(['organization_suspended']);
    expect(program(P1).causes[0]).toMatchObject({ reason: null, decidedBy: null });
    expect(session(P1, uuid('12'))).toMatchObject({ status: 'suspended', agents: [] });
    expect(events('cleaning.program.suspended')[0]!.payload).toMatchObject({
      programId: P1,
      causes: ['organization_suspended'],
      unpaidCount: null,
      threshold: null,
    });
    expect(program(P3).causes.map((cause) => cause.cause)).toEqual([
      'ksp_decision',
      'organization_suspended',
    ]);

    // Réactivation plus ancienne que la suspension appliquée : ignorée.
    const before = structuredClone(organizations.state);
    expect(await decision('reactivated', '2026-03-01T12:00:00.000Z')).toEqual({ status: 'stale' });
    expect(organizations.state.ksp).toEqual(before.ksp);
    expect(organizations.state.programs).toEqual(before.programs);
    expect(organizations.state.events).toEqual(before.events);

    clock.time = at('2026-03-09T08:00:00.000Z');
    expect(await decision('reactivated', '2026-03-09T07:59:00.000Z')).toMatchObject({
      status: 'processed',
      resumed: 2,
      updated: 1,
    });
    expect(organizations.state.ksp.get(ORG)).toMatchObject({ suspended: false });
    expect(program(P1)).toMatchObject({ status: 'in_progress', causes: [] });
    expect(events('cleaning.program.resumed')[0]!.payload).toMatchObject({
      programId: P1,
      liftedCause: 'organization_suspended',
    });
    // Le programme suspendu par décision de KSP garde sa cause : il ne reprend pas.
    expect(program(P3).status).toBe('suspended');
    expect(program(P3).causes.map((cause) => cause.cause)).toEqual(['ksp_decision']);
  });

  it('à date égale, la suspension l’emporte', async () => {
    const { organizations, decision, program } = setup();
    seedPrograms(organizations);
    const same = '2026-03-02T08:00:00.000Z';
    await decision('reactivated', same);
    expect(await decision('suspended', same)).toMatchObject({ status: 'processed', suspended: 2 });
    expect(await decision('reactivated', same)).toEqual({ status: 'stale' });
    expect(organizations.state.ksp.get(ORG)).toMatchObject({ suspended: true });
    expect(program(P1).status).toBe('suspended');
  });

  it('un événement rejoué ne change rien', async () => {
    const { organizations, useCases } = setup();
    seedPrograms(organizations);
    const event = {
      eventId: uuid('e1'),
      decision: 'suspended' as const,
      organizationId: ORG.toUpperCase(),
      occurredAt: at('2026-03-02T08:00:00.000Z'),
    };
    await useCases.onOrganizationDecision(event);
    const before = structuredClone(organizations.state);
    expect(await useCases.onOrganizationDecision(event)).toEqual({ status: 'duplicate' });
    expect(organizations.state).toEqual(before);
  });

  it('cumule les causes : le programme ne reprend que lorsque toutes sont levées', async () => {
    const { organizations, invoice, decision, events, program } = setup();
    seedPrograms(organizations);
    await invoice('overdue', FEBRUARY);
    await invoice('overdue', MARCH);
    await decision('suspended', '2026-03-02T08:00:00.000Z');
    expect(program(P1).causes.map((cause) => cause.cause)).toEqual([
      'unpaid_invoices',
      'organization_suspended',
    ]);

    // Paiement : la cause des impayés est levée, l'organisation reste suspendue par KSP.
    expect(await invoice('paid', MARCH)).toMatchObject({ resumed: 0, updated: 3 });
    expect(program(P1)).toMatchObject({ status: 'suspended' });
    expect(program(P1).causes.map((cause) => cause.cause)).toEqual(['organization_suspended']);
    expect(events('cleaning.program.resumed')).toHaveLength(0);

    await decision('reactivated', '2026-03-10T08:00:00.000Z');
    expect(program(P1)).toMatchObject({ status: 'in_progress', causes: [] });
    expect(program(P3).status).toBe('suspended');
  });

  it('réévalue la situation d’impayés à la reprise : l’avertissement retenu pendant la suspension part', async () => {
    const { organizations, invoice, decision, events } = setup();
    seedPrograms(organizations);
    await decision('suspended', '2026-02-10T08:00:00.000Z');
    // Tous les programmes sont suspendus : pas d'avertissement (R-SU-01).
    expect(await invoice('overdue', FEBRUARY)).toMatchObject({ unpaidCount: 1, warned: false });
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 1, warningLevel: 0 });

    expect(await decision('reactivated', '2026-02-12T08:00:00.000Z')).toMatchObject({
      status: 'processed',
      resumed: 2,
      warned: true,
      unpaidCount: 1,
    });
    expect(events('cleaning.organization.unpaid_warning')).toHaveLength(1);
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 1, warningLevel: 1 });
    // L'événement de reprise précède l'avertissement.
    const types = organizations.state.events.map((event) => event.type);
    expect(types.lastIndexOf('cleaning.program.resumed')).toBeLessThan(
      types.indexOf('cleaning.organization.unpaid_warning'),
    );
  });
});

describe('Réévaluation après un changement des seuils (UC-NT-43)', () => {
  it('relève le seuil de suspension : les programmes reprennent, l’organisation est avertie', async () => {
    const { organizations, useCases, invoice, events, program } = setup();
    seedPrograms(organizations);
    await invoice('overdue', FEBRUARY);
    await invoice('overdue', MARCH);
    expect(program(P1).status).toBe('suspended');

    organizations.settings = { ...organizations.settings, unpaidInvoicesSuspension: 3 };
    expect(await useCases.reevaluateAll()).toEqual({ reevaluated: 1, failed: [] });
    expect(program(P1)).toMatchObject({ status: 'in_progress', causes: [] });
    expect(events('cleaning.organization.unpaid_warning').at(-1)!.payload).toMatchObject({
      unpaidCount: 2,
      suspensionThreshold: 3,
    });

    // Rien ne change si les seuils ne changent rien.
    const before = structuredClone(organizations.state);
    expect(await useCases.reevaluateAll()).toEqual({ reevaluated: 1, failed: [] });
    expect(organizations.state).toEqual(before);

    organizations.settings = { ...organizations.settings, unpaidInvoicesSuspension: 2 };
    await useCases.reevaluateAll();
    expect(program(P1).status).toBe('suspended');
    expect(events('cleaning.program.suspended').at(-1)!.payload).toMatchObject({
      unpaidCount: 2,
      threshold: 2,
    });
  });

  it('l’échec d’une organisation n’arrête pas les autres', async () => {
    const { organizations, useCases, invoice, reported } = setup();
    seedPrograms(organizations);
    await invoice('overdue', FEBRUARY);
    await invoice('overdue', MARCH, OTHER_ORG);
    organizations.settings = {
      ...organizations.settings,
      unpaidInvoicesWarning: 2,
      unpaidInvoicesSuspension: 3,
    };
    organizations.failing.add(ORG);
    expect(await useCases.reevaluateAll()).toEqual({ reevaluated: 1, failed: [ORG] });
    expect(reported).toEqual([ORG]);
  });
});

describe('Réglages lus par la situation des organisations', () => {
  it('rend les seuils, le délai minimum et les jours sans rattrapage d’un programme', async () => {
    const organizations = new FakeOrganizations();
    organizations.state.programs.set(
      P1,
      programRecord({ id: P1, organizationId: ORG, excludedDates: ['2026-03-17'] }),
    );
    organizations.state.sessions.set(P1, []);
    organizations.state.holidays = ['2026-04-06'];
    const settings = new StandingSettings(organizations.moduleSettings, organizations.reader, {
      now: () => at('2026-03-02T08:00:00.000Z'),
    });
    expect(await settings.thresholds()).toEqual({ warning: 1, suspension: 2 });
    expect(await settings.firstSessionLeadHours()).toBe(48);
    expect([...(await settings.excludedDays(P1))].sort()).toEqual(['2026-03-17', '2026-04-06']);
    expect((await settings.excludedDays(P2)).size).toBe(0);
  });
});
