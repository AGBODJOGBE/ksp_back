import { runWithContext } from '@ksp/platform';
import { TariffsUseCases } from '../src/application/catalog/tariffs.use-cases';
import { type CleaningDeps } from '../src/application/deps';
import { type WalletHolder } from '../src/application/money/money.ports';
import {
  LOT_C_USE_CASES,
  lotCUseCases,
  type LotCUseCases,
} from '../src/application/requests/lot-c-use-cases';
import { asStaff as asCatalogStaff, CatalogMemory } from '../src/application/testing/catalog-fakes';
import { seedMaison, SOL_TARIFF, VITRES_TARIFF } from '../src/application/testing/catalog-fixtures';
import { AesGcmFieldCipher } from '../src/infrastructure/crypto/aes-gcm-field-cipher';
import {
  PrismaCatalogSettingsReader,
  PrismaIdempotencyStore,
} from '../src/infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaCleaningTypeRepository } from '../src/infrastructure/persistence/catalog/prisma-cleaning-type.repository';
import { PrismaHolidayRepository } from '../src/infrastructure/persistence/catalog/prisma-holiday.repository';
import { PrismaOfferRepository } from '../src/infrastructure/persistence/catalog/prisma-offer.repository';
import { PrismaParameterRepository } from '../src/infrastructure/persistence/catalog/prisma-parameter.repository';
import { PrismaPlaceCatalogRepository } from '../src/infrastructure/persistence/catalog/prisma-place-catalog.repository';
import { PrismaZoneRepository } from '../src/infrastructure/persistence/catalog/prisma-zone.repository';
import { PrismaPlanningRepository } from '../src/infrastructure/persistence/planning/prisma-planning.repository';
import { PrismaCaseSettingsReader } from '../src/infrastructure/persistence/requests/prisma-case-settings';
import { PrismaCaseRepository } from '../src/infrastructure/persistence/requests/prisma-case.repository';
import { PrismaClientPlacesRepository } from '../src/infrastructure/persistence/requests/prisma-client-places.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/**
 * Critère du lot C (partie 18) sur une vraie base : « parcours complet jusqu'à un programme
 * confirmé, avec un écart déclaré / constaté affiché au client et les frais de visite déduits ».
 * Dépôts Prisma du dossier, des lieux, du catalogue et de la planification ; wallet, payment, geo
 * et file remplacés par des faux. Le catalogue est celui de la partie 5 (« Maison », sol et vitres).
 *
 * Parcours : lieu enregistré → demande (solde nul : frais à payer) → paiement Mobile Money de ce qui
 * manque → crédit du wallet (wallet.prepaid.credited, forObject) qui débite les frais → visite
 * planifiée puis clôturée par le back-office avec 150 m² constatés (120 déclarés) → retenu → devis
 * envoyé → le client voit l'écart → acceptation : programme confirmé, séances « à affecter », frais
 * déduits de la première séance. Puis : deux répliques de la tâche des échéances.
 */
jest.setTimeout(120_000);

const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
const STAFF = '0192f1c4-0000-7000-8000-00000000ad01';
const VISIT_FEE = 5_000;
const COTONOU = { latitude: 6.3654, longitude: 2.4183 };

const at = (iso: string) => new Date(iso);

function asCustomer<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      correlationId: '0192f1c4-0000-7000-8000-0000000000c2',
      user: { userId: CUSTOMER, sessionId: 's-c', activeContext: 'personal', roles: [], mfa: false },
    },
    fn,
  );
}

function asStaff<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      correlationId: '0192f1c4-0000-7000-8000-0000000000c3',
      user: {
        userId: STAFF,
        sessionId: 's-s',
        activeContext: 'personal',
        roles: [{ role: 'cleaning_supervisor', scopeType: 'global' }],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000) - 60,
        permissions: [
          'cleaning.request.read',
          'cleaning.request.process',
          'cleaning.quote.manage',
          'cleaning.amounts.read',
        ],
      },
    },
    fn,
  );
}

/** Wallet en mémoire : débit jamais partiel, idempotent par clé (ADR-046). */
class FakeWallet {
  balance = 0;
  private readonly debits = new Map<string, { transactionId: string; amount: number }>();
  private seq = 0;

  ledger(): CleaningDeps['wallet'] {
    return {
      debit: async (input) => {
        const known = this.debits.get(input.idempotencyKey);
        if (known) return { ...known, created: false };
        if (this.balance < input.amount) {
          throw Object.assign(new Error('Solde insuffisant'), { code: 'WALLET_INSUFFICIENT_FUNDS' });
        }
        this.balance -= input.amount;
        const debit = {
          transactionId: `0192f1c4-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`,
          amount: input.amount,
        };
        this.debits.set(input.idempotencyKey, debit);
        return { ...debit, created: true };
      },
      // Lot G : crédit d'une réclamation, hors du lot C.
      credit: async () => {
        throw new Error('Crédit du wallet hors du lot C');
      },
      refund: async () => undefined,
    };
  }
}

describeWithDatabase('critère du lot C : de la demande au programme confirmé (vraie base)', () => {
  let db: TestDatabase;
  let useCases: LotCUseCases;
  let deps: CleaningDeps;
  let now = at('2026-11-20T09:00:00Z');
  const wallet = new FakeWallet();
  const pages: { amount: number; key: string }[] = [];
  const ids = new UuidV7Generator();
  const memory = new CatalogMemory();
  const catalog = seedMaison(memory);

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_c');
    // Tarifs publiés en mémoire, puis catalogue recopié en base par les dépôts du lot A.
    const tariffs = new TariffsUseCases(memory.deps());
    for (const [offerId, tariff, key] of [
      [catalog.solOfferId, SOL_TARIFF, 'cle-sol-0001'],
      [catalog.vitresOfferId, VITRES_TARIFF, 'cle-vitres-01'],
    ] as const) {
      await asCatalogStaff(() => tariffs.createDraft({ ...tariff, offerId, idempotencyKey: key }));
      await asCatalogStaff(() => tariffs.publish({ offerId, version: 1, idempotencyKey: `${key}-p` }));
    }
    const none = { events: [], audit: [] };
    const places = new PrismaPlaceCatalogRepository(db.prisma, ids);
    const parameters = new PrismaParameterRepository(db.prisma, ids);
    const cleaningTypes = new PrismaCleaningTypeRepository(db.prisma, ids);
    const offers = new PrismaOfferRepository(db.prisma, ids);
    const zones = new PrismaZoneRepository(db.prisma, ids);
    for (const parameter of memory.parameters.values())
      await parameters.saveParameter(parameter, 'create', none);
    for (const category of memory.categories.values()) {
      await places.saveCategory({ ...category, visitFee: VISIT_FEE }, 'create', none);
    }
    for (const placeType of memory.placeTypes.values()) await places.savePlaceType(placeType, 'create', none);
    for (const skill of memory.skills.values())
      await cleaningTypes.saveSkill({ ...skill, id: ids.next() }, 'create', now, none);
    for (const type of [...memory.cleaningTypes.values()].sort(
      (a, b) => Number(a.isPack) - Number(b.isPack),
    )) {
      await cleaningTypes.saveCleaningType(type, 'create', none);
    }
    for (const offer of memory.offers.values()) await offers.saveOffer(offer, 'create', none);
    for (const tariff of memory.tariffs.values()) {
      await offers.saveDraft({ ...tariff, status: 'draft' }, 'create', none);
      await offers.publish({
        tariffId: tariff.id,
        previousPublishedId: null,
        at: now,
        by: STAFF,
        changes: none,
      });
    }
    for (const zone of memory.zones.values())
      await zones.saveZone({ ...zone, id: ids.next() }, 'create', none);

    const clock = { now: () => now };
    deps = {
      people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
      wallet: wallet.ledger(),
      photos: { attach: async () => undefined, remove: async () => undefined, list: async () => [] },
      geocoder: {
        reverse: async () => ({
          provider: 'nominatim',
          communes: ['Cotonou'],
          displayAddress: 'Haie Vive, Cotonou',
        }),
      },
      planning: new PrismaPlanningRepository(db.prisma, clock, ids),
      travel: { matrix: async () => () => null },
      cipher: AesGcmFieldCipher.fromConfig(undefined, 'test'),
      clock,
      ids,
      places,
      parameters,
      cleaningTypes,
      offers,
      zones,
      holidays: new PrismaHolidayRepository(db.prisma, ids),
      settings: new PrismaCatalogSettingsReader(db.prisma),
      communes: { listCommunes: async () => [{ key: 'cotonou', name: 'Cotonou' }] },
      idempotency: new PrismaIdempotencyStore(db.prisma),
      cases: new PrismaCaseRepository(db.prisma, ids),
      clientPlaces: new PrismaClientPlacesRepository(db.prisma, ids),
      caseSettings: new PrismaCaseSettingsReader(db.prisma),
      communeResolver: {
        resolve: async () => ({ commune: { key: 'cotonou', name: 'Cotonou' }, boundariesVersion: 'test-1' }),
      },
      balances: { available: async (_holder: WalletHolder) => wallet.balance },
      directPayments: {
        createPaymentRequest: async (input) => {
          pages.push({ amount: input.amount, key: input.idempotencyKey });
          return {
            paymentId: '0192f1c4-0000-7000-8000-0000000000aa',
            checkoutUrl: 'https://pay.test/p',
            expiresAt: input.expiresAt,
            created: true,
          };
        },
      },
      // Lot G : hors du dossier.
      autoPlanning: {} as CleaningDeps['autoPlanning'],
      moduleSettings: {} as CleaningDeps['moduleSettings'],
      claims: {} as CleaningDeps['claims'],
    };
    useCases = lotCUseCases(deps);
    expect(LOT_C_USE_CASES).toBeDefined();
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const events = async (type: string) =>
    (await db.prisma.outboxEvent.findMany({ where: { eventType: type }, orderBy: { createdAt: 'asc' } })).map(
      (row) =>
        (row.payload as { payload?: Record<string, unknown> }).payload ??
        (row.payload as Record<string, unknown>),
    );

  it('parcours complet : écart déclaré / constaté montré au client, frais de visite déduits', async () => {
    // 1. Lieu enregistré dans « Mes lieux », commune par contour, position chiffrée.
    const place = await asCustomer(() =>
      useCases.places.create({
        idempotencyKey: 'cle-lieu-0001',
        name: 'Villa de Cotonou',
        placeTypeId: catalog.placeTypeId,
        ...COTONOU,
        landmark: 'Portail bleu',
        declaredValues: { superficie: 120 },
      }),
    );
    expect(place.location).toMatchObject({ ...COTONOU, landmark: 'Portail bleu' });
    const stored = await db.prisma.place.findUniqueOrThrow({ where: { id: place.place.id } });
    expect(stored.gpsEncrypted).not.toContain('6.3654');

    // 2. Demande : solde nul, les frais de visite attendent leur paiement (R-FV-02).
    const submitted = await asCustomer(() =>
      useCases.submit.execute({
        idempotencyKey: 'cle-demande-01',
        placeId: place.place.id,
        cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
        values: { superficie: 120, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 },
        schedule: {
          kind: 'weekly',
          startTime: '08:00',
          dates: [],
          weekdays: ['mon'],
          monthDays: [],
          monthWeekdays: [],
          startDate: '2026-11-30',
          durationWeeks: 2,
          excludedDates: [],
          addedDates: [],
          excludeHolidays: false,
        },
        visitSlots: [{ start: '2026-11-21T09:00:00Z', end: '2026-11-21T12:00:00Z' }],
        photoFileIds: [],
      }),
    );
    expect(submitted.request.number).toMatch(/^DN-\d{6,}$/);
    expect(submitted.request.status).toBe('awaiting_visit_fee');
    expect(submitted.fees[0]).toMatchObject({ amount: VISIT_FEE, status: 'awaiting_payment' });
    expect(await events('cleaning.request.submitted')).toEqual([
      expect.objectContaining({ requestId: submitted.request.id, visitFeeStatus: 'awaiting_payment' }),
    ]);
    // Rejouée avec la même clé : la même demande, aucun doublon (R-DM-06).
    const replay = await asCustomer(() =>
      useCases.submit.execute({
        idempotencyKey: 'cle-demande-01',
        placeId: place.place.id,
        cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
        values: { superficie: 120, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 },
        schedule: {
          kind: 'weekly',
          startTime: '08:00',
          dates: [],
          weekdays: ['mon'],
          monthDays: [],
          monthWeekdays: [],
          startDate: '2026-11-30',
          durationWeeks: 2,
          excludedDates: [],
          addedDates: [],
          excludeHolidays: false,
        },
        visitSlots: [{ start: '2026-11-21T09:00:00Z', end: '2026-11-21T12:00:00Z' }],
        photoFileIds: [],
      }),
    );
    expect(replay.request.id).toBe(submitted.request.id);
    expect(await db.prisma.cleaningRequest.count()).toBe(1);

    // 3. Mobile Money : page de ce qui manque au solde (RV-95), puis le crédit du wallet débite.
    wallet.balance = 2_000;
    const outcome = await asCustomer(() =>
      useCases.requests.payVisitFee({
        requestId: submitted.request.id,
        idempotencyKey: 'cle-paie-0001',
        method: 'mobile_money',
      }),
    );
    expect(outcome).toMatchObject({
      status: 'awaiting_payment',
      amount: 3_000,
      checkoutUrl: 'https://pay.test/p',
    });
    expect(pages).toHaveLength(1);
    wallet.balance += 3_000;
    const credited = await useCases.money.onPrepaidCredited({
      eventId: '0192f1c4-0000-7000-8000-0000000000e1',
      holder: { type: 'user', id: CUSTOMER },
      forObject: {
        service: 'cleaning',
        objectType: 'cleaning_request',
        objectId: submitted.request.id,
        part: 'visit_fee',
      },
      paymentId: '0192f1c4-0000-7000-8000-0000000000aa',
    });
    expect(credited.debitedRequestIds).toEqual([submitted.request.id]);
    expect(wallet.balance).toBe(0);
    const again = await useCases.money.onPrepaidCredited({
      eventId: '0192f1c4-0000-7000-8000-0000000000e1',
      holder: { type: 'user', id: CUSTOMER },
      paymentId: null,
    });
    expect(again.status).toBe('duplicate');
    const paid = await asCustomer(() => useCases.requests.get(submitted.request.id));
    expect(paid.request.status).toBe('visit_to_schedule');
    expect(paid.fees[0]?.status).toBe('paid');

    // 4. Visite planifiée (sans agent : planification automatique), puis clôturée par le back-office.
    now = at('2026-11-20T15:00:00Z');
    const scheduled = await asStaff(() =>
      useCases.visitsAdmin.schedule({
        requestId: submitted.request.id,
        idempotencyKey: 'cle-visite-01',
        scheduledAt: '2026-11-21T09:00:00Z',
        agentIds: [],
        overrides: [],
      }),
    );
    expect(scheduled.request.status).toBe('visit_scheduled');
    const visitId = scheduled.visits[0]!.id;
    now = at('2026-11-21T10:00:00Z');
    const completed = await asStaff(() =>
      useCases.visitsAdmin.completeOnBehalf({
        visitId,
        idempotencyKey: 'cle-cloture-1',
        reason: 'Agent sans réseau, constat dicté par téléphone',
        completedAt: '2026-11-21T09:45:00Z',
        values: { superficie: 150, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 },
        photoFileIds: [],
      }),
    );
    expect(completed.request.status).toBe('visit_done');

    // 5. Retenu = constaté (aucun motif exigé), devis composé puis envoyé.
    now = at('2026-11-21T11:00:00Z');
    const retained = await asStaff(() =>
      useCases.retained.save({
        requestId: submitted.request.id,
        values: { superficie: 150, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 },
        cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
      }),
    );
    expect(retained.comparison.confirmed).toBe(false);
    const draft = await asStaff(() =>
      useCases.quotesAdmin.create({ requestId: submitted.request.id, idempotencyKey: 'cle-devis-001' }),
    );
    expect(draft.quote).toMatchObject({ status: 'draft', sessionsCount: 2, visitFeeDeduction: VISIT_FEE });
    const sent = await asStaff(() =>
      useCases.quotesAdmin.send({ quoteId: draft.quote.id, idempotencyKey: 'cle-envoi-001' }),
    );
    expect(sent.quote.status).toBe('sent');
    expect(sent.quote.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(sent.quote.sessionPrice);

    // 6. Le client voit l'écart : 120 m² déclarés, 150 retenus, effet positif sur le prix (R-CS-02).
    const seen = await asCustomer(() => useCases.requests.get(submitted.request.id));
    expect(seen.request.status).toBe('quote_sent');
    const revision = seen.revisions.at(-1)!;
    const area = (
      revision.diff as { parameterCode: string; declared: number; retained: number; priceEffect: number }[]
    ).find((row) => row.parameterCode === 'superficie');
    expect(area).toMatchObject({ declared: 120, retained: 150 });
    expect(area!.priceEffect).toBeGreaterThan(0);
    expect(revision.lockedAt).not.toBeNull();

    // 7. Acceptation : programme confirmé, séances « à affecter », frais déduits de la première.
    now = at('2026-11-21T22:00:00Z');
    const accepted = await asCustomer(() =>
      useCases.quotes.accept({
        quoteId: draft.quote.id,
        idempotencyKey: 'cle-accept-01',
        acceptTerms: true,
        termsVersion: draft.quote.termsVersion,
      }),
    );
    expect(accepted.program.number).toMatch(/^PN-\d{6,}$/);
    const program = await db.prisma.program.findUniqueOrThrow({
      where: { id: accepted.program.id },
      include: { sessions: { orderBy: { rank: 'asc' } } },
    });
    expect(program).toMatchObject({
      status: 'confirmed',
      visitFeeToDeduct: VISIT_FEE,
      payerKind: 'individual',
    });
    expect(program.sessions.map((session) => [session.status, session.visitFeeDeducted])).toEqual([
      ['to_assign', VISIT_FEE],
      ['to_assign', 0],
    ]);
    const after = await asCustomer(() => useCases.requests.get(submitted.request.id));
    expect(after.request.status).toBe('accepted');
    expect(after.fees[0]?.status).toBe('deducted');
    expect(await events('cleaning.program.confirmed')).toEqual([
      expect.objectContaining({ programId: program.id, programNumber: program.number, sessionsCount: 2 }),
    ]);
    // Aucun événement ne porte de position ni d'adresse (16.3).
    const outbox = await db.prisma.outboxEvent.findMany();
    expect(JSON.stringify(outbox.map((row) => row.payload))).not.toMatch(
      /latitude|longitude|landmark|Portail/,
    );
  });

  it('tâche des échéances : une seule réplique passe à la fois (verrou consultatif)', async () => {
    let inner: boolean | null = null;
    const outer = await deps.cases.withDeadlinesLock(async () => {
      inner = await deps.cases.withDeadlinesLock(async () => undefined);
    });
    expect(outer).toBe(true);
    expect(inner).toBe(false);
    const report = await useCases.deadlines.execute();
    expect(report).toMatchObject({ ran: true, failed: 0 });
  });
});
