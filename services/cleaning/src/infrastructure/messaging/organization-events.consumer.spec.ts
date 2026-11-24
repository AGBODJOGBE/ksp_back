import { type RabbitMqConsumer } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type CleaningDeps } from '../../application/deps';
import {
  FakeOrganizations,
  programRecord,
  sessionRecord,
} from '../../application/testing/organization-fakes';
import { OrganizationEventsConsumer } from './organization-events.consumer';

type Handler = (envelope: Record<string, unknown>) => Promise<void>;

const uuid = (suffix: string) => `0196b1c0-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG = uuid('a1');
const PROGRAM = uuid('b1');
const NOW = new Date('2026-03-02T08:00:00.000Z');

/** Démarre l'écouteur sur une base en mémoire ; rend les gestionnaires par type d'événement. */
async function start() {
  const organizations = new FakeOrganizations();
  organizations.state.programs.set(PROGRAM, programRecord({ id: PROGRAM, organizationId: ORG }));
  organizations.state.sessions.set(PROGRAM, [
    sessionRecord({
      id: uuid('11'),
      programId: PROGRAM,
      rank: 1,
      status: 'assigned',
      start: new Date('2026-03-20T09:00:00.000Z'),
      agentIds: [uuid('c1')],
    }),
  ]);
  const handlers = new Map<string, Handler>();
  const subscribe = jest.fn(
    async (type: string, handler: Handler, _options?: unknown) => void handlers.set(type, handler),
  );
  const deps = {
    organizations,
    execution: organizations.reader,
    moduleSettings: organizations.moduleSettings,
    clock: { now: () => NOW },
  } as unknown as CleaningDeps;
  await new OrganizationEventsConsumer(
    { subscribe } as unknown as RabbitMqConsumer,
    deps,
  ).onApplicationBootstrap();
  const handle = (type: string, envelope: Record<string, unknown>) => handlers.get(type)!(envelope);
  return { organizations, subscribe, handle };
}

let sequence = 0;
const invoice = (type: string, invoiceId: string, payload: Record<string, unknown> = {}, version = 2) => ({
  eventId: uuid(`e${(sequence += 1)}`),
  type,
  version,
  occurredAt: NOW.toISOString(),
  payload: { invoiceId, organizationId: ORG, source: 'cleaning', kind: 'monthly', ...payload },
});

describe('OrganizationEventsConsumer : impayés et suspension des organisations (UC-NT-47)', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('s’abonne une fois à chaque type ; versions 1 et 2 pour les factures de billing', async () => {
    const { subscribe } = await start();
    expect(subscribe.mock.calls.map(([type, , options]) => [type, options])).toEqual([
      ['billing.invoice.overdue', { versions: [1, 2] }],
      ['billing.invoice.paid', { versions: [1, 2] }],
      ['identity.organization.suspended', undefined],
      ['identity.organization.reactivated', undefined],
    ]);
  });

  it('deux factures mensuelles impayées suspendent les programmes ; le paiement les reprend', async () => {
    const { organizations, handle } = await start();
    await handle('billing.invoice.overdue', invoice('billing.invoice.overdue', uuid('f1')));
    expect(organizations.state.events.map((event) => event.type)).toEqual([
      'cleaning.organization.unpaid_warning',
    ]);
    await handle('billing.invoice.overdue', invoice('billing.invoice.overdue', uuid('f2')));
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('suspended');
    await handle(
      'billing.invoice.paid',
      invoice('billing.invoice.paid', uuid('f1'), { settledBy: 'payment' }),
    );
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('confirmed');
    expect(logged).toEqual([
      'Facture mensuelle impayée : 1 impayée(s), 0 programme(s) suspendu(s), 0 repris, 0 cause(s) changée(s), avertissement envoyé',
      'Facture mensuelle impayée : 2 impayée(s), 1 programme(s) suspendu(s), 0 repris, 0 cause(s) changée(s)',
      'Facture mensuelle soldée : 1 impayée(s), 0 programme(s) suspendu(s), 1 repris, 0 cause(s) changée(s)',
    ]);
    // Jamais l'identifiant de l'organisation dans le journal.
    expect(logged.join(' ')).not.toContain(ORG);
  });

  it('ignore une facture de séance et une facture v1 (sans `kind`), sans rien journaliser', async () => {
    const { organizations, handle } = await start();
    await handle(
      'billing.invoice.overdue',
      invoice('billing.invoice.overdue', uuid('f1'), { kind: 'session' }),
    );
    await handle(
      'billing.invoice.overdue',
      invoice('billing.invoice.overdue', uuid('f2'), { kind: undefined, contractId: uuid('d1') }, 1),
    );
    expect(organizations.state.invoices.size).toBe(0);
    expect(organizations.state.processed.size).toBe(0);
    expect(logged).toEqual([]);
  });

  it('date la décision de KSP par `occurredAt` de l’événement : un événement plus ancien est ignoré', async () => {
    const { organizations, handle } = await start();
    const decision = (type: string, occurredAt: string) => ({
      eventId: uuid(`e${(sequence += 1)}`),
      type,
      version: 1,
      occurredAt,
      payload: {
        organizationId: ORG,
        legalName: 'Société Test',
        suspendedBy: uuid('d1'),
        reason: 'Contrôle',
      },
    });
    await handle(
      'identity.organization.suspended',
      decision('identity.organization.suspended', '2026-03-02T07:00:00.000Z'),
    );
    expect(organizations.state.ksp.get(ORG)).toEqual({
      organizationId: ORG,
      suspended: true,
      changedAt: new Date('2026-03-02T07:00:00.000Z'),
    });
    expect(organizations.state.programs.get(PROGRAM)!.causes.map((cause) => cause.cause)).toEqual([
      'organization_suspended',
    ]);
    await handle(
      'identity.organization.reactivated',
      decision('identity.organization.reactivated', '2026-03-01T07:00:00.000Z'),
    );
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('suspended');
    await handle(
      'identity.organization.reactivated',
      decision('identity.organization.reactivated', '2026-03-03T07:00:00.000Z'),
    );
    expect(organizations.state.programs.get(PROGRAM)!.status).toBe('confirmed');
    expect(logged).toEqual([
      'Organisation suspendue par KSP : 0 impayée(s), 1 programme(s) suspendu(s), 0 repris, 0 cause(s) changée(s)',
      'Organisation réactivée par KSP : 0 impayée(s), 0 programme(s) suspendu(s), 1 repris, 0 cause(s) changée(s)',
    ]);
    // Le motif (texte libre) et la raison sociale ne sont ni gardés ni publiés.
    expect(JSON.stringify([...organizations.state.programs.values()])).not.toContain('Contrôle');
    expect(JSON.stringify(organizations.state.events)).not.toContain('Société Test');
  });

  it('laisse remonter un échec : le message repart en file de reprise, rien n’est gardé', async () => {
    const { organizations, handle } = await start();
    organizations.failing.add(ORG);
    const event = invoice('billing.invoice.overdue', uuid('f1'));
    await expect(handle('billing.invoice.overdue', event)).rejects.toThrow('Échec de la transaction');
    expect(organizations.state.processed.size).toBe(0);
    await handle('billing.invoice.overdue', event);
    expect(organizations.state.invoices.get(uuid('f1'))!.standing).toBe('overdue');
  });
});
