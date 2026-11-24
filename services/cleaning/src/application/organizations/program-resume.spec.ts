import { runWithContext } from '@ksp/platform';
import { type ExecutionDeps, type OrganizationDeps } from '../deps';
import { AdminProgramUseCases, PROGRAM_MANAGE, PROGRAM_READ } from '../execution/admin-programs.use-cases';
import { FakeOrganizations, programRecord, sessionRecord } from '../testing/organization-fakes';
import { OrganizationStandingUseCases } from './standing.use-cases';

/**
 * Reprise d'un programme d'organisation par le back-office (ResumeProgram, lot E) : la décision se
 * prend sous le verrou de l'organisation et sa situation d'impayés est réévaluée dans la même
 * transaction (R-SU-01, RV-85). Base en mémoire.
 */
const uuid = (suffix: string) => `0196b1c0-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG = uuid('a1');
const PROGRAM = uuid('b1');
const STAFF = uuid('d1');
const NOW = new Date('2026-03-02T08:00:00.000Z');

function asStaff<T>(fn: () => T): T {
  return runWithContext(
    {
      correlationId: 'test',
      callerService: 'gateway',
      user: {
        userId: STAFF,
        sessionId: 's',
        activeContext: 'personal',
        roles: [],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000),
        permissions: [PROGRAM_READ, PROGRAM_MANAGE],
      },
    },
    fn,
  );
}

function setup(personal = false) {
  const organizations = new FakeOrganizations();
  organizations.state.programs.set(
    PROGRAM,
    programRecord({
      id: PROGRAM,
      organizationId: ORG,
      personal,
      causes: [
        {
          cause: 'ksp_decision',
          since: new Date('2026-02-01T08:00:00Z'),
          reason: 'Contrôle',
          decidedBy: STAFF,
        },
      ],
    }),
  );
  organizations.state.sessions.set(PROGRAM, [
    sessionRecord({
      id: uuid('11'),
      programId: PROGRAM,
      rank: 1,
      status: 'suspended',
      start: new Date('2026-03-20T09:00:00.000Z'),
    }),
  ]);
  const deps = {
    organizations,
    execution: organizations.execution,
    idempotency: organizations.idempotency,
    moduleSettings: organizations.moduleSettings,
    clock: { now: () => NOW },
  } as unknown as ExecutionDeps & OrganizationDeps;
  const locked: string[][] = [];
  const transaction = organizations.execution.transaction.bind(organizations.execution);
  organizations.execution.transaction = (work) =>
    transaction(async (tx) => {
      const result = await work(tx);
      locked.push([...(tx as unknown as { locked: string[] }).locked]);
      return result;
    });
  return {
    organizations,
    locked,
    standings: new OrganizationStandingUseCases(deps),
    programs: new AdminProgramUseCases(deps),
  };
}

describe('Reprise d’un programme d’organisation par KSP : réévaluation des impayés', () => {
  it('prend le verrou de l’organisation avant celui du programme, puis envoie l’avertissement retenu', async () => {
    const { organizations, locked, standings, programs } = setup();
    // Une facture impayée pendant que le seul programme est suspendu : pas d'avertissement.
    const overdue = await standings.onInvoiceEvent({
      eventId: uuid('e1'),
      event: 'overdue',
      invoiceId: uuid('f1'),
      organizationId: ORG,
      source: 'cleaning',
      kind: 'monthly',
    });
    expect(overdue).toMatchObject({ unpaidCount: 1, warned: false });

    const view = await asStaff(() =>
      programs.resumeProgram({ programId: PROGRAM, idempotencyKey: 'cle-reprise-0001' }),
    );
    expect(view.program).toMatchObject({ status: 'confirmed', causes: [] });
    expect(locked.at(-1)!.slice(0, 2)).toEqual([`organisation ${ORG}`, PROGRAM]);
    expect(organizations.state.events.map((event) => event.type)).toEqual([
      'cleaning.program.resumed',
      'cleaning.organization.unpaid_warning',
    ]);
    expect(organizations.state.events[0]!.payload).toMatchObject({ liftedCause: 'ksp_decision' });
    expect(organizations.state.billing.get(ORG)).toMatchObject({ overdueCount: 1, warningLevel: 1 });
    expect(organizations.state.audit.map((entry) => [entry.actorId, entry.action])).toEqual([
      [STAFF, 'program.resumed'],
      ['system', 'organization.unpaid_warning'],
    ]);

    // Même clé rejouée : la réponse gardée, sans nouvel effet.
    const replayed = await asStaff(() =>
      programs.resumeProgram({ programId: PROGRAM, idempotencyKey: 'cle-reprise-0001' }),
    );
    expect(replayed.program.status).toBe('confirmed');
    expect(organizations.state.events).toHaveLength(2);
    expect(organizations.state.idempotency).toHaveLength(1);
  });

  it('sans impayé, la reprise ne publie que son événement', async () => {
    const { organizations, programs } = setup();
    await asStaff(() => programs.resumeProgram({ programId: PROGRAM, idempotencyKey: 'cle-reprise-0002' }));
    expect(organizations.state.events.map((event) => event.type)).toEqual(['cleaning.program.resumed']);
    expect(organizations.state.billing.has(ORG)).toBe(false);
  });

  it('programme d’un particulier : aucun verrou d’organisation', async () => {
    const { organizations, locked, programs } = setup(true);
    await asStaff(() => programs.resumeProgram({ programId: PROGRAM, idempotencyKey: 'cle-reprise-0003' }));
    expect(locked.at(-1)![0]).toBe(PROGRAM);
    expect(organizations.state.events.map((event) => event.type)).toEqual(['cleaning.program.resumed']);
  });
});
