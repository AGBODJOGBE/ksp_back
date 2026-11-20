import { asStaff, CatalogMemory, STAFF_ID } from '../testing/catalog-fakes';
import { seedMaison, SOL_TARIFF } from '../testing/catalog-fixtures';
import { OffersUseCases } from './offers.use-cases';
import { TariffsUseCases } from './tariffs.use-cases';

function setup() {
  const memory = new CatalogMemory();
  const catalog = seedMaison(memory);
  const deps = memory.deps();
  return { memory, catalog, offers: new OffersUseCases(deps), tariffs: new TariffsUseCases(deps) };
}

describe('UC-NT-28 — offres (R-CA-03, R-CA-10, R-CA-12, R-CA-13)', () => {
  it('crée une offre inactive, masquée, sans tarif ; une seule par lieu et type', async () => {
    const { memory, catalog, offers } = setup();
    memory.offers.delete(catalog.solOfferId);
    const input = {
      idempotencyKey: 'cle-offre-001',
      placeTypeId: catalog.placeTypeId,
      cleaningTypeId: catalog.solTypeId,
      teamRule: [{ fromArea: 0, toArea: null, agents: 2, durationMinutes: 180 }],
    };
    const offer = await asStaff(() => offers.create(input));
    expect(offer).toMatchObject({
      active: false,
      currentTariffVersion: null,
      draftTariffVersion: null,
      hiddenReasons: ['inactive'],
      extraParameters: [],
    });
    expect(memory.audit.at(-1)).toMatchObject({ action: 'catalog.offer.created', entityType: 'offer' });
    await expect(
      asStaff(() => offers.create({ ...input, idempotencyKey: 'cle-offre-002' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_CODE_ALREADY_USED',
      details: { code: 'sol' },
    });
  });

  it('refuse un lieu, un type ou un paramètre inconnus, une règle d’équipe avec un trou', async () => {
    const { catalog, offers } = setup();
    const base = {
      idempotencyKey: 'cle-offre-003',
      placeTypeId: catalog.placeTypeId,
      cleaningTypeId: catalog.solTypeId,
    };
    await expect(asStaff(() => offers.create({ ...base, placeTypeId: 'x' }))).rejects.toMatchObject({
      code: 'CLEANING_PLACE_TYPE_NOT_FOUND',
    });
    await expect(asStaff(() => offers.create({ ...base, cleaningTypeId: 'x' }))).rejects.toMatchObject({
      code: 'CLEANING_TYPE_NOT_FOUND',
    });
    await expect(asStaff(() => offers.create({ ...base, extraParameterIds: ['x'] }))).rejects.toMatchObject({
      code: 'CLEANING_PARAMETER_NOT_FOUND',
    });
    await expect(
      asStaff(() =>
        offers.update({
          id: catalog.solOfferId,
          teamRule: [{ fromArea: 10, toArea: null, agents: 1, durationMinutes: 60 }],
        }),
      ),
    ).rejects.toMatchObject({ details: { field: 'teamRule[0]', reason: 'team_rule_gap' } });
  });

  it('modifie, désactive, liste par lieu ou type ; visible quand tout est actif', async () => {
    const { catalog, offers } = setup();
    const visible = await asStaff(() => offers.get(catalog.solOfferId));
    expect(visible.hiddenReasons).toEqual([]);
    const updated = await asStaff(() => offers.update({ id: catalog.solOfferId, active: false, order: 3 }));
    expect(updated).toMatchObject({ active: false, order: 3, hiddenReasons: ['inactive'] });
    expect((await asStaff(() => offers.list({ placeTypeId: catalog.placeTypeId }))).total).toBe(2);
    expect((await asStaff(() => offers.list({ cleaningTypeId: catalog.vitresTypeId }))).items).toHaveLength(
      1,
    );
    await expect(asStaff(() => offers.get('x'))).rejects.toMatchObject({ code: 'CLEANING_OFFER_NOT_FOUND' });
    await expect(asStaff(() => offers.update({ id: 'x' }))).rejects.toMatchObject({
      code: 'CLEANING_OFFER_NOT_FOUND',
    });
  });
});

describe('UC-NT-28 — tarifs : brouillon, publication, archivage (R-CA-07, R-CA-08, R-CA-11)', () => {
  it('brouillon v1, publié, puis brouillon v2 publié : v1 archivée', async () => {
    const { memory, catalog, tariffs, offers } = setup();
    const draft = await asStaff(() =>
      tariffs.createDraft({ ...SOL_TARIFF, offerId: catalog.solOfferId, idempotencyKey: 'cle-tarif-001' }),
    );
    expect(draft).toMatchObject({
      version: 1,
      status: 'draft',
      baseParameterCode: 'superficie',
      createdBy: STAFF_ID,
    });
    expect((await asStaff(() => offers.get(catalog.solOfferId))).draftTariffVersion).toBe(1);
    const published = await asStaff(() =>
      tariffs.publish({ offerId: catalog.solOfferId, version: 1, idempotencyKey: 'cle-publie-01' }),
    );
    expect(published).toMatchObject({ status: 'published', publishedBy: STAFF_ID });
    await asStaff(() =>
      tariffs.createDraft({
        ...SOL_TARIFF,
        minimum: 12_000,
        offerId: catalog.solOfferId,
        idempotencyKey: 'cle-tarif-002',
      }),
    );
    await asStaff(() =>
      tariffs.publish({ offerId: catalog.solOfferId, version: 2, idempotencyKey: 'cle-publie-02' }),
    );
    const versions = await asStaff(() => tariffs.list({ offerId: catalog.solOfferId }));
    expect(versions.items.map((tariff) => [tariff.version, tariff.status])).toEqual([
      [2, 'published'],
      [1, 'archived'],
    ]);
    expect(await asStaff(() => offers.get(catalog.solOfferId))).toMatchObject({
      currentTariffVersion: 2,
      draftTariffVersion: null,
    });
    expect(memory.audit.map((entry) => entry.action)).toEqual([
      'catalog.tariff.draft_saved',
      'catalog.tariff.published',
      'catalog.tariff.draft_saved',
      'catalog.tariff.published',
      'catalog.tariff.archived',
    ]);
  });

  it('un seul brouillon ; PUT sur un brouillon seulement ; publié rejoué par son auteur', async () => {
    const { catalog, tariffs } = setup();
    await asStaff(() =>
      tariffs.createDraft({ ...SOL_TARIFF, offerId: catalog.solOfferId, idempotencyKey: 'cle-tarif-001' }),
    );
    await expect(
      asStaff(() =>
        tariffs.createDraft({ ...SOL_TARIFF, offerId: catalog.solOfferId, idempotencyKey: 'cle-tarif-002' }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'draft', to: 'draft' } });
    const updated = await asStaff(() =>
      tariffs.updateDraft({ ...SOL_TARIFF, minimum: 15_000, offerId: catalog.solOfferId, version: 1 }),
    );
    expect(updated.minimum).toBe(15_000);
    await asStaff(() =>
      tariffs.publish({ offerId: catalog.solOfferId, version: 1, idempotencyKey: 'cle-publie-01' }),
    );
    await expect(
      asStaff(() => tariffs.updateDraft({ ...SOL_TARIFF, offerId: catalog.solOfferId, version: 1 })),
    ).rejects.toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'published', to: 'draft' },
    });
    await expect(
      asStaff(() =>
        tariffs.publish({ offerId: catalog.solOfferId, version: 1, idempotencyKey: 'cle-publie-02' }),
      ),
    ).resolves.toMatchObject({ status: 'published' });
    await expect(
      asStaff(
        () => tariffs.publish({ offerId: catalog.solOfferId, version: 1, idempotencyKey: 'cle-publie-03' }),
        'autre-admin',
      ),
    ).rejects.toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'published', to: 'published' },
    });
    await expect(
      asStaff(() =>
        tariffs.publish({ offerId: catalog.solOfferId, version: 9, idempotencyKey: 'cle-publie-04' }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_TARIFF_NOT_FOUND' });
  });

  it('tarif incohérent : raison et rang (R-CA-11) ; paramètre inconnu', async () => {
    const { catalog, tariffs } = setup();
    const create = (patch: object, key: string) =>
      asStaff(() =>
        tariffs.createDraft({ ...SOL_TARIFF, ...patch, offerId: catalog.solOfferId, idempotencyKey: key }),
      );
    await expect(
      create(
        { brackets: [SOL_TARIFF.brackets[0], { from: 60, to: 150, mode: 'per_unit', amount: 180 }] },
        'cle-tarif-101',
      ),
    ).rejects.toMatchObject({
      code: 'CLEANING_TARIFF_INCOMPLETE',
      details: { reason: 'brackets_gap', index: 1 },
    });
    await expect(create({ baseParameterCode: 'cour' }, 'cle-tarif-102')).rejects.toMatchObject({
      details: { reason: 'base_not_number' },
    });
    await expect(create({ baseParameterCode: 'fenetres' }, 'cle-tarif-103')).rejects.toMatchObject({
      details: { reason: 'base_not_asked', index: null },
    });
    await expect(create({ baseParameterCode: 'inconnu' }, 'cle-tarif-104')).rejects.toMatchObject({
      code: 'CLEANING_PARAMETER_NOT_FOUND',
      details: { parameterCode: 'inconnu' },
    });
    await expect(
      create({ brackets: [{ from: 0, to: 10, mode: 'forfait', amount: 1 }] }, 'cle-tarif-105'),
    ).rejects.toMatchObject({
      details: { field: 'brackets[0].mode', reason: 'invalid_type' },
    });
    await expect(create({ minimum: undefined }, 'cle-tarif-106')).rejects.toMatchObject({
      details: { field: 'minimum', reason: 'required' },
    });
    await expect(
      create({ packDiscountBps: 1000, baseParameterCode: undefined, brackets: [] }, 'cle-tarif-107'),
    ).rejects.toMatchObject({
      details: { field: 'packDiscountBps', reason: 'not_applicable' },
    });
  });

  it('base absente : superficie du lieu (R-CA-14) ; publication sans tranche refusée', async () => {
    const { catalog, tariffs } = setup();
    const draft = await asStaff(() =>
      tariffs.createDraft({
        ...SOL_TARIFF,
        baseParameterCode: undefined,
        brackets: [],
        offerId: catalog.solOfferId,
        idempotencyKey: 'cle-tarif-201',
      }),
    );
    expect(draft.baseParameterCode).toBe('superficie');
    await expect(
      asStaff(() =>
        tariffs.publish({ offerId: catalog.solOfferId, version: 1, idempotencyKey: 'cle-publie-21' }),
      ),
    ).rejects.toMatchObject({
      code: 'CLEANING_TARIFF_INCOMPLETE',
      details: { reason: 'brackets_gap', index: 0 },
    });
    await expect(asStaff(() => tariffs.list({ offerId: 'x' }))).rejects.toMatchObject({
      code: 'CLEANING_OFFER_NOT_FOUND',
    });
  });
});
