import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Metadata } from '@grpc/grpc-js';
import { type recoveryV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { type Observable, of } from 'rxjs';
import { RECOVERY_ROUTES } from '../../domain/routing/recovery-routes';
import { present, RecoveryGrpcAdapter } from './recovery-grpc.adapter';
import { RECOVERY_OPERATIONS } from './recovery-operations';
import { RECOVERY_SHAPES, type RecoveryShapeName } from './recovery-shapes';

type Call = { method: string; request: Record<string, unknown>; metadata: Metadata };

/** Client gRPC simulé : toute méthode répond `responses[méthode]` et note l'appel. */
function setup(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const client = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (request: Record<string, unknown>, metadata: Metadata): Observable<unknown> => {
          calls.push({ method, request, metadata });
          return of(responses[method] ?? {});
        },
    },
  );
  const adapter = new RecoveryGrpcAdapter(
    {
      creditor: client as recoveryV1.RecoveryCreditorServiceClient,
      debtor: client as recoveryV1.RecoveryDebtorServiceClient,
      partner: client as recoveryV1.RecoveryPartnerServiceClient,
      admin: client as recoveryV1.RecoveryAdminServiceClient,
    },
    new GrpcCaller({ target: 'recovery', defaultDeadlineMs: 50, retryBackoffMs: 1 }),
  );
  return { adapter, calls };
}

const CASE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001';
const SESSION = 'k3Jd9fQ2mZ7xB1vR8tY4wP6sN0cH5gL2aE9uI3oK7qT';
const actor = { type: 'staff', userId: CASE_ID, displayName: 'Chargé' };
const entry = (id: string, internal: boolean) => ({
  id,
  kind: internal ? 'note' : 'contact',
  summary: internal ? 'Débiteur menace de déménager' : 'Appel',
  author: actor,
  internal,
  occurredAt: '2026-12-15T09:00:00.000Z',
});

describe('RecoveryGrpcAdapter : présentation des réponses', () => {
  it('seuls les champs du contrat sortent ; valeurs absentes selon leur forme', () => {
    const out = present('RecoveryPartner', {
      id: CASE_ID,
      kind: 'bailiff',
      name: 'Me Hounsou',
      office: '',
      communeKeys: ['cotonou'],
      phones: undefined,
      fees: [{ actType: 'summons_to_pay', amount: { amount: 15000, currency: 'XOF' }, internalCost: 1 }],
      status: 'active',
      verifiedBy: undefined,
      averageDelayDays: -1,
      successRateBps: 0,
      openAssignments: 2,
      createdAt: '2026-12-15T09:00:00.000Z',
      // Champ interne ajouté au message gRPC : jamais rendu.
      internalRating: 3,
    });
    expect(out).toEqual({
      id: CASE_ID,
      kind: 'bailiff',
      name: 'Me Hounsou',
      office: null,
      communeKeys: ['cotonou'],
      phones: [],
      email: null,
      userId: null,
      fees: [{ actType: 'summons_to_pay', amount: { amount: 15000, currency: 'XOF' } }],
      status: 'active',
      verificationFileId: null,
      verifiedBy: null,
      verifiedAt: null,
      averageDelayDays: null,
      successRateBps: 0,
      openAssignments: 2,
      createdAt: '2026-12-15T09:00:00.000Z',
    });
  });

  it('montants : absent → 0 XOF, facultatif absent → null, devise reprise', () => {
    expect(present('RecoveryPricingTier', {})).toEqual({
      upTo: null,
      rateBps: 0,
      fixedAmount: { amount: 0, currency: 'XOF' },
    });
    expect(
      present('RecoveryFeeQuoteLine', { label: 'Acte', amount: { amount: 5000, currency: '' } }),
    ).toEqual({
      label: 'Acte',
      amount: { amount: 5000, currency: 'XOF' },
    });
  });

  it('objet obligatoire absent : réponse refusée (500), jamais un objet vide', () => {
    let error: unknown;
    try {
      present('RecoveryPromise', { id: CASE_ID, amount: { amount: 1 } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'GATEWAY_UPSTREAM_ERROR', kind: 'INTERNAL' });
  });

  it('formes : chaque type est connu et chaque référence existe', () => {
    const kinds = Object.values(RECOVERY_SHAPES).flatMap((fields) => Object.values(fields) as string[]);
    for (const kind of kinds) {
      const base = kind.replace(/^\[\]/, '').replace(/\?$/, '');
      if (base.startsWith('#')) expect(Object.keys(RECOVERY_SHAPES)).toContain(base.slice(1));
      else expect(['str', 'int', 'bool', 'money', 'map']).toContain(base);
    }
  });
});

describe('RecoveryGrpcAdapter : demandes gRPC', () => {
  it('un champ du corps ne remplace jamais le paramètre du chemin', async () => {
    const { adapter, calls } = setup({ stopCase: { case: {} } });
    await adapter
      .call('recoveryStopCase', {
        params: { id: CASE_ID },
        body: { reason: 'Payé directement', caseId: 'autre-dossier' },
      })
      .catch(() => undefined);
    expect(calls[0]!.request).toEqual({ reason: 'Payé directement', caseId: CASE_ID });
  });

  it('filtres et page rangés dans leurs sous-messages ; null du corps retiré ; clé transmise', async () => {
    const { adapter, calls } = setup({ listCases: { cases: [], total: 0 } });
    await adapter.call('recoveryAdminListCases', {
      query: { status: 'active', agentId: CASE_ID, prescriptionNear: true, limit: 10 },
    });
    expect(calls[0]!.request).toEqual({
      filter: { statuses: ['active'], assignedAgentId: CASE_ID, prescriptionNear: true },
      page: { limit: 10 },
    });

    await adapter
      .call('recoveryAdminCreatePricingRule', {
        body: { label: 'Commission', tiers: [{ upTo: null, rateBps: 500 }] },
        idempotencyKey: 'cle-0192f1c4-0003',
      })
      .catch(() => undefined);
    expect(calls[1]!.request).toEqual({
      input: { label: 'Commission', tiers: [{ rateBps: 500 }] },
      idempotencyKey: 'cle-0192f1c4-0003',
    });
  });

  it('session du débiteur en métadonnée seulement sur ses routes', async () => {
    const { adapter, calls } = setup();
    await adapter.call('recoveryEndDebtorSession', { debtorSession: SESSION });
    await adapter.call('recoveryGetMyDashboard', {});
    expect(calls[0]!.metadata.get('x-debtor-session')).toEqual([SESSION]);
    expect(calls[1]!.metadata.get('x-debtor-session')).toEqual([]);
  });

  it('journal du créancier : une note interne rendue par erreur est retirée ; back-office inchangé', async () => {
    const page = { entries: [entry('e-1', false), entry('e-2', true)], nextCursor: '' };
    const { adapter } = setup({ listMyCaseJournal: page, listCaseJournal: page });
    const creditor = await adapter.call('recoveryListMyCaseJournal', { params: { id: CASE_ID } });
    expect((creditor['entries'] as { id: string }[]).map((e) => e.id)).toEqual(['e-1']);
    expect(JSON.stringify(creditor)).not.toContain('déménager');
    const admin = await adapter.call('recoveryAdminListCaseJournal', { params: { id: CASE_ID } });
    expect((admin['entries'] as { id: string }[]).map((e) => e.id)).toEqual(['e-1', 'e-2']);
  });
});

/**
 * Table des opérations confrontée à recovery.proto : chaque champ alimenté ou rendu existe dans
 * son message, avec le même type (une faute de nom donnerait sinon une valeur vide en silence).
 */
describe('RecoveryGrpcAdapter : table confrontée à recovery.proto', () => {
  const proto = readFileSync(
    resolve(__dirname, '../../../../../contracts/proto/ksp/recovery/v1/recovery.proto'),
    'utf8',
  );
  const camel = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const fields = (message: string): Record<string, { type: string; repeated: boolean }> => {
    if (new RegExp(`^message ${message} \\{\\}`, 'm').test(proto)) return {};
    const body = new RegExp(`^message ${message} \\{\\r?\\n([\\s\\S]*?)^\\}`, 'm').exec(proto)?.[1];
    if (body === undefined) throw new Error(`message ${message} absent de recovery.proto`);
    return Object.fromEntries(
      [...body.matchAll(/^\s*(repeated\s+)?(map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*\d+;/gm)].map((f) => [
        camel(f[3]!),
        { type: f[2]!, repeated: Boolean(f[1]) },
      ]),
    );
  };
  const scalar: Record<string, string> = { string: 'str', int32: 'int', int64: 'int', bool: 'bool' };

  function compare(shape: RecoveryShapeName, message: string, problems: string[], seen = new Set<string>()) {
    if (seen.has(`${shape}/${message}`)) return;
    seen.add(`${shape}/${message}`);
    const protoFields = fields(message);
    for (const [name, raw] of Object.entries(RECOVERY_SHAPES[shape]) as [string, string][]) {
      const field = protoFields[name];
      if (!field) {
        problems.push(`${shape}.${name} absent de ${message}`);
        continue;
      }
      const kind = raw.replace(/\?$/, '');
      if (kind.startsWith('[]') !== field.repeated) problems.push(`${shape}.${name} : liste incohérente`);
      const base = kind.replace(/^\[\]/, '');
      if (base.startsWith('#')) compare(base.slice(1) as RecoveryShapeName, field.type, problems, seen);
      else if (base === 'money') {
        if (field.type !== 'ksp.common.v1.Money')
          problems.push(`${shape}.${name} : ${field.type}, pas Money`);
      } else if (base === 'map') {
        if (!field.type.startsWith('map<')) problems.push(`${shape}.${name} : ${field.type}, pas map`);
      } else if (scalar[field.type] !== base) problems.push(`${shape}.${name} : ${base} pour ${field.type}`);
    }
  }

  it('demandes, réponses et formes de chaque route', () => {
    const problems: string[] = [];
    for (const route of RECOVERY_ROUTES) {
      const operation = RECOVERY_OPERATIONS[route.operationId];
      const rpc = route.grpc.split('/')[1]!;
      if (operation.method !== rpc[0]!.toLowerCase() + rpc.slice(1)) problems.push(`${rpc} : méthode`);
      const request = fields(`${rpc}Request`);
      const targets = [
        ...Object.values(operation.path ?? {}),
        ...Object.values(operation.query ?? {}).map((target) => target.split('.')[0]!.replace('[]', '')),
        ...(operation.body && operation.body !== 'spread' ? [operation.body] : []),
        ...(operation.idempotencyKey ? ['idempotencyKey'] : []),
      ];
      for (const target of targets) if (!request[target]) problems.push(`${rpc}Request.${target} absent`);
      if (Boolean(operation.idempotencyKey) !== Boolean(request['idempotencyKey'])) {
        problems.push(`${rpc} : clé d'idempotence`);
      }
      if (Boolean(operation.idempotencyKey) !== 'idempotencyKey' in route)
        problems.push(`${rpc} : manifeste`);
      const response = `${rpc}Response`;
      if (operation.unwrap === 'settingsView') {
        compare('RecoverySettings', fields(response)['settings']!.type, problems);
      } else if (operation.unwrap) {
        const field = fields(response)[operation.unwrap];
        if (!field) problems.push(`${response}.${operation.unwrap} absent`);
        else compare(operation.shape, field.type, problems);
      } else compare(operation.shape, response, problems);
    }
    expect(problems).toEqual([]);
  });
});
