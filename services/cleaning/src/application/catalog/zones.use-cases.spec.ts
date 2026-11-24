import { asStaff, CatalogMemory } from '../testing/catalog-fakes';
import { ZonesUseCases } from './zones.use-cases';

function setup() {
  const memory = new CatalogMemory();
  return { memory, zones: new ZonesUseCases(memory.deps()) };
}

describe('UC-NT-29 — zones desservies (partie 4, R-FV-01, R-ZN-03)', () => {
  it('ouvre une commune du référentiel : nom officiel, coefficient neutre par défaut, tracée', async () => {
    const { memory, zones } = setup();
    const zone = await asStaff(() =>
      zones.create({ idempotencyKey: 'cle-zone-0001', communeKey: 'abomey-calavi', visitFeeSurcharge: 1000 }),
    );
    expect(zone).toMatchObject({
      communeKey: 'abomey-calavi',
      name: 'Abomey-Calavi',
      coefficientBps: 10_000,
      visitFeeSurcharge: 1000,
      planningMode: null,
      active: true,
      openRequests: 0,
      activePrograms: 0,
    });
    expect(memory.audit[0]).toMatchObject({
      action: 'zone.created',
      details: { after: { communeKey: 'abomey-calavi' } },
    });
  });

  it('clé inconnue de geo, geo indisponible, commune déjà ouverte : refus', async () => {
    const { memory, zones } = setup();
    await expect(
      asStaff(() => zones.create({ idempotencyKey: 'cle-zone-0001', communeKey: 'paris' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'communeKey', reason: 'unknown_commune' },
    });
    await asStaff(() => zones.create({ idempotencyKey: 'cle-zone-0002', communeKey: 'cotonou' }));
    await expect(
      asStaff(() => zones.create({ idempotencyKey: 'cle-zone-0003', communeKey: 'cotonou' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_CODE_ALREADY_USED',
      details: { code: 'cotonou' },
    });
    memory.communes = null;
    await expect(
      asStaff(() => zones.create({ idempotencyKey: 'cle-zone-0004', communeKey: 'porto-novo' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_GEO_UNAVAILABLE',
    });
    await expect(asStaff(() => zones.listCommunes())).rejects.toMatchObject({
      code: 'CLEANING_GEO_UNAVAILABLE',
    });
    expect(memory.zones.size).toBe(1);
  });

  it('modifie coefficient, majoration et mode ; bornes contrôlées', async () => {
    const { zones } = setup();
    const zone = await asStaff(() =>
      zones.create({ idempotencyKey: 'cle-zone-0001', communeKey: 'cotonou' }),
    );
    const updated = await asStaff(() =>
      zones.update({ zoneId: zone.id, coefficientBps: 11_000, planningMode: 'automatic' }),
    );
    expect(updated).toMatchObject({ coefficientBps: 11_000, planningMode: 'automatic', name: 'Cotonou' });
    await expect(asStaff(() => zones.update({ zoneId: zone.id, coefficientBps: 0 }))).rejects.toMatchObject({
      details: { field: 'coefficientBps', reason: 'out_of_range' },
    });
    await expect(asStaff(() => zones.update({ zoneId: 'x' }))).rejects.toMatchObject({
      code: 'CLEANING_ZONE_NOT_FOUND',
    });
  });

  it('désactivation d’une zone avec des dossiers en cours : confirmation exigée, compteurs tracés', async () => {
    const { memory, zones } = setup();
    const zone = await asStaff(() =>
      zones.create({ idempotencyKey: 'cle-zone-0001', communeKey: 'cotonou' }),
    );
    memory.activity.set('cotonou', {
      requests: [
        { status: 'visit_scheduled' },
        { status: 'quote_sent', sentQuoteValidUntil: new Date('2026-11-01T00:00:00Z') },
        { status: 'accepted' },
      ],
      activePrograms: 2,
    });
    await expect(
      asStaff(() => zones.setActive({ zoneId: zone.id, idempotencyKey: 'cle-actif-001', active: false })),
    ).rejects.toMatchObject({
      code: 'CLEANING_ZONE_HAS_ACTIVITY',
      details: { openRequests: 1, activePrograms: 2 },
    });
    const off = await asStaff(() =>
      zones.setActive({ zoneId: zone.id, idempotencyKey: 'cle-actif-002', active: false, confirm: true }),
    );
    expect(off).toMatchObject({ active: false, openRequests: 1, activePrograms: 2 });
    expect(memory.audit.at(-1)).toMatchObject({
      action: 'zone.activation_changed',
      details: { active: false, openRequests: 1, activePrograms: 2, confirmed: true },
    });
    const writes = memory.writes;
    await expect(
      asStaff(() => zones.setActive({ zoneId: zone.id, idempotencyKey: 'cle-actif-003', active: false })),
    ).resolves.toMatchObject({ active: false });
    expect(memory.writes).toBe(writes);
  });

  it('liste triée par nom ; communes du référentiel avec leur zone', async () => {
    const { zones } = setup();
    const zone = await asStaff(() =>
      zones.create({ idempotencyKey: 'cle-zone-0001', communeKey: 'porto-novo' }),
    );
    await asStaff(() => zones.create({ idempotencyKey: 'cle-zone-0002', communeKey: 'cotonou' }));
    expect((await asStaff(() => zones.list({}))).items.map((item) => item.name)).toEqual([
      'Cotonou',
      'Porto-Novo',
    ]);
    const communes = await asStaff(() => zones.listCommunes());
    expect(communes).toContainEqual({
      communeKey: 'porto-novo',
      name: 'Porto-Novo',
      zoneId: zone.id,
      zoneActive: true,
    });
    expect(communes).toContainEqual({
      communeKey: 'abomey-calavi',
      name: 'Abomey-Calavi',
      zoneId: null,
      zoneActive: false,
    });
  });
});
