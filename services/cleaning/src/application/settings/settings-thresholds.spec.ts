import { runWithContext } from '@ksp/platform';
import { type CleaningDeps, type OrganizationDeps } from '../deps';
import { OrganizationStandingUseCases } from '../organizations/standing.use-cases';
import { FakeOrganizations, programRecord, sessionRecord } from '../testing/organization-fakes';
import { SettingsUseCases } from './settings.use-cases';

/**
 * Changement des seuils d'impayés (UC-NT-43, piste O) : les organisations concernées sont
 * réévaluées aussitôt, sur une base en mémoire.
 */
const uuid = (suffix: string) => `0196b1c0-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG = uuid('a1');
const PROGRAM = uuid('b1');
const ADMIN = uuid('d1');

function asAdmin<T>(fn: () => T): T {
  return runWithContext(
    {
      correlationId: 'test',
      callerService: 'gateway',
      user: {
        userId: ADMIN,
        sessionId: 's',
        activeContext: 'personal',
        roles: [],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000),
        permissions: ['cleaning.request.read', 'cleaning.settings.manage'],
      },
    },
    fn,
  );
}

async function setup() {
  const organizations = new FakeOrganizations();
  organizations.state.programs.set(PROGRAM, programRecord({ id: PROGRAM, organizationId: ORG }));
  organizations.state.sessions.set(PROGRAM, [
    sessionRecord({
      id: uuid('11'),
      programId: PROGRAM,
      rank: 1,
      status: 'to_assign',
      start: new Date('2026-03-20T09:00:00.000Z'),
    }),
  ]);
  const reported: string[] = [];
  const deps = {
    organizations,
    execution: organizations.reader,
    moduleSettings: organizations.moduleSettings,
    clock: { now: () => new Date('2026-03-02T08:00:00.000Z') },
    people: { userNames: async () => new Map<string, string>() },
  } as unknown as CleaningDeps;
  // Deux factures impayées : le programme est suspendu au seuil par défaut (2).
  const standings = new OrganizationStandingUseCases(deps as OrganizationDeps);
  for (const [index, invoiceId] of [uuid('f1'), uuid('f2')].entries()) {
    await standings.onInvoiceEvent({
      eventId: uuid(`e${index}`),
      event: 'overdue',
      invoiceId,
      organizationId: ORG,
      source: 'cleaning',
      kind: 'monthly',
    });
  }
  const settings = new SettingsUseCases(deps, (organizationId) => reported.push(organizationId));
  return { organizations, settings, reported };
}

describe('Réglages : changement des seuils d’impayés', () => {
  it('réévalue les organisations concernées dès que le seuil de suspension change', async () => {
    const { organizations, settings } = await setup();
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('suspended');

    await asAdmin(() => settings.update({ unpaidInvoicesSuspension: 3 }));
    expect(organizations.state.programs.get(PROGRAM)!).toMatchObject({ status: 'confirmed', causes: [] });
    expect(organizations.state.events.at(-1)).toMatchObject({
      type: 'cleaning.organization.unpaid_warning',
      payload: { unpaidCount: 2, warningThreshold: 1, suspensionThreshold: 3 },
    });

    await asAdmin(() => settings.update({ unpaidInvoicesSuspension: 2 }));
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('suspended');
  });

  it('ne réévalue rien quand un autre réglage change', async () => {
    const { organizations, settings } = await setup();
    const transactions = organizations.trace.length;
    await asAdmin(() => settings.update({ planningHorizonDays: 21 }));
    expect(organizations.trace).toHaveLength(transactions);
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('suspended');
  });

  it('signale l’organisation dont la réévaluation échoue, sans faire échouer la modification', async () => {
    const { organizations, settings, reported } = await setup();
    organizations.failing.add(ORG);
    const view = await asAdmin(() => settings.update({ unpaidInvoicesSuspension: 3 }));
    expect(view.settings.unpaidInvoicesSuspension).toBe(3);
    expect(reported).toEqual([ORG]);
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('suspended');
  });
});
