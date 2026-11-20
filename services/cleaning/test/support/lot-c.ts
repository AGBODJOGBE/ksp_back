import { runWithContext } from '@ksp/platform';
import { TariffsUseCases } from '../../src/application/catalog/tariffs.use-cases';
import { type CleaningDeps } from '../../src/application/deps';
import { lotCUseCases, type LotCUseCases } from '../../src/application/requests/lot-c-use-cases';
import { type SubmitRequestInput } from '../../src/application/requests/submit-request.use-case';
import { asStaff as asCatalogStaff, CatalogMemory } from '../../src/application/testing/catalog-fakes';
import {
  type MaisonCatalog,
  seedMaison,
  SOL_TARIFF,
  VITRES_TARIFF,
} from '../../src/application/testing/catalog-fixtures';
import { AesGcmFieldCipher } from '../../src/infrastructure/crypto/aes-gcm-field-cipher';
import {
  PrismaCatalogSettingsReader,
  PrismaIdempotencyStore,
} from '../../src/infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaCleaningTypeRepository } from '../../src/infrastructure/persistence/catalog/prisma-cleaning-type.repository';
import { PrismaHolidayRepository } from '../../src/infrastructure/persistence/catalog/prisma-holiday.repository';
import { PrismaOfferRepository } from '../../src/infrastructure/persistence/catalog/prisma-offer.repository';
import { PrismaParameterRepository } from '../../src/infrastructure/persistence/catalog/prisma-parameter.repository';
import { PrismaPlaceCatalogRepository } from '../../src/infrastructure/persistence/catalog/prisma-place-catalog.repository';
import { PrismaZoneRepository } from '../../src/infrastructure/persistence/catalog/prisma-zone.repository';
import { PrismaPlanningRepository } from '../../src/infrastructure/persistence/planning/prisma-planning.repository';
import { PrismaCaseSettingsReader } from '../../src/infrastructure/persistence/requests/prisma-case-settings';
import { PrismaCaseRepository } from '../../src/infrastructure/persistence/requests/prisma-case.repository';
import { PrismaClientPlacesRepository } from '../../src/infrastructure/persistence/requests/prisma-client-places.repository';
import { UuidV7Generator } from '../../src/infrastructure/system/system';
import { openTestDatabase, type TestDatabase } from './database';

/**
 * Banc d'essai du lot C sur une vraie base : catalogue « Maison » (partie 5, sol et vitres) recopié
 * en base par les dépôts du lot A, dépôts Prisma du dossier et de la planification ; wallet,
 * payment, geo et file remplacés par des faux. Horloge réglable.
 */
export const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
export const STAFF = '0192f1c4-0000-7000-8000-00000000ad01';
export const VISIT_FEE = 5_000;
export const COTONOU = { latitude: 6.3654, longitude: 2.4183 };
export const VILLA = { superficie: 120, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 };

export function asCustomer<T>(fn: () => Promise<T>, userId = CUSTOMER): Promise<T> {
  return runWithContext(
    {
      correlationId: '0192f1c4-0000-7000-8000-0000000000c2',
      user: { userId, sessionId: 's-c', activeContext: 'personal', roles: [], mfa: false },
    },
    fn,
  );
}

export function asStaff<T>(fn: () => Promise<T>, userId = STAFF): Promise<T> {
  return runWithContext(
    {
      correlationId: '0192f1c4-0000-7000-8000-0000000000c3',
      user: {
        userId,
        sessionId: 's-s',
        activeContext: 'personal',
        roles: [{ role: 'cleaning_supervisor', scopeType: 'global' }],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000) - 60,
        permissions: [
          'cleaning.request.read',
          'cleaning.request.process',
          'cleaning.quote.manage',
          'cleaning.quote.adjust_price',
          'cleaning.amounts.read',
        ],
      },
    },
    fn,
  );
}

/** Wallet en mémoire : débit jamais partiel, idempotent par clé (ADR-046), remboursements notés. */
export class FakeWallet {
  balance = 0;
  readonly refunds: string[] = [];
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
      refund: async ({ transactionId }) => {
        if (this.refunds.includes(transactionId)) return;
        const debit = [...this.debits.values()].find((item) => item.transactionId === transactionId);
        this.balance += debit?.amount ?? 0;
        this.refunds.push(transactionId);
      },
    };
  }
}

export interface LotCBench {
  db: TestDatabase;
  deps: CleaningDeps;
  useCases: LotCUseCases;
  catalog: MaisonCatalog;
  wallet: FakeWallet;
  pages: { amount: number; key: string }[];
  setNow(iso: string): void;
  /** Lieu à Cotonou puis demande hebdomadaire (2 lundis) : rend la demande créée. */
  submit(key: string, patch?: Partial<SubmitRequestInput>): ReturnType<LotCUseCases['submit']['execute']>;
  /** Demande portée jusqu'au devis envoyé (frais payés, visite clôturée, retenu à 150 m²). */
  toQuoteSent(key: string): Promise<{ requestId: string; quoteId: string }>;
}

export async function openLotCBench(prefix: string): Promise<LotCBench> {
  const db = await openTestDatabase(prefix);
  const ids = new UuidV7Generator();
  let now = new Date('2026-11-20T09:00:00Z');
  const memory = new CatalogMemory();
  const catalog = seedMaison(memory);
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
  for (const type of [...memory.cleaningTypes.values()].sort((a, b) => Number(a.isPack) - Number(b.isPack))) {
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
  for (const zone of memory.zones.values()) await zones.saveZone({ ...zone, id: ids.next() }, 'create', none);

  const wallet = new FakeWallet();
  const pages: { amount: number; key: string }[] = [];
  const clock = { now: () => now };
  const deps: CleaningDeps = {
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
    balances: { available: async () => wallet.balance },
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
  const useCases = lotCUseCases(deps);
  const setNow = (iso: string) => {
    now = new Date(iso);
  };

  const submit: LotCBench['submit'] = async (key, patch = {}) => {
    const place = await asCustomer(() =>
      useCases.places.create({
        idempotencyKey: `cle-lieu-${key}`,
        name: 'Villa de Cotonou',
        placeTypeId: catalog.placeTypeId,
        ...COTONOU,
        landmark: 'Portail bleu',
      }),
    );
    return asCustomer(() =>
      useCases.submit.execute({
        idempotencyKey: `cle-demande-${key}`,
        placeId: place.place.id,
        cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
        values: VILLA,
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
        ...patch,
      }),
    );
  };

  const toQuoteSent: LotCBench['toQuoteSent'] = async (key) => {
    setNow('2026-11-20T09:00:00Z');
    wallet.balance += VISIT_FEE;
    const submitted = await submit(key);
    const requestId = submitted.request.id;
    setNow('2026-11-20T15:00:00Z');
    const scheduled = await asStaff(() =>
      useCases.visitsAdmin.schedule({
        requestId,
        idempotencyKey: `cle-visite-${key}`,
        scheduledAt: '2026-11-21T09:00:00Z',
        agentIds: [],
        overrides: [],
      }),
    );
    setNow('2026-11-21T10:00:00Z');
    await asStaff(() =>
      useCases.visitsAdmin.completeOnBehalf({
        visitId: scheduled.visits[0]!.id,
        idempotencyKey: `cle-cloture-${key}`,
        reason: 'Constat dicté par téléphone',
        completedAt: '2026-11-21T09:45:00Z',
        values: { ...VILLA, superficie: 150 },
        photoFileIds: [],
      }),
    );
    setNow('2026-11-21T11:00:00Z');
    await asStaff(() =>
      useCases.retained.save({
        requestId,
        values: { ...VILLA, superficie: 150 },
        cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
      }),
    );
    const draft = await asStaff(() =>
      useCases.quotesAdmin.create({ requestId, idempotencyKey: `cle-devis-${key}` }),
    );
    await asStaff(() =>
      useCases.quotesAdmin.send({ quoteId: draft.quote.id, idempotencyKey: `cle-envoi-${key}` }),
    );
    return { requestId, quoteId: draft.quote.id };
  };

  return { db, deps, useCases, catalog, wallet, pages, setNow, submit, toQuoteSent };
}
