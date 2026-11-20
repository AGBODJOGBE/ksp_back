import { byDisplayOrder, offerHiddenReasons, placeTypeHiddenReasons, publicCatalog } from './visibility';

const chain = (patch = {}) => ({
  active: true,
  categoryActive: true,
  isOther: false,
  offers: [{ active: true, typeActive: true }],
  ...patch,
});

describe('visibilité publique en cascade (R-CA-12)', () => {
  it('un lieu actif, de catégorie active, avec une offre active de type actif est visible', () => {
    expect(placeTypeHiddenReasons(chain())).toEqual([]);
  });

  it('donne toutes les raisons du masquage', () => {
    expect(
      placeTypeHiddenReasons(
        chain({ active: false, categoryActive: false, offers: [{ active: true, typeActive: false }] }),
      ),
    ).toEqual(['inactive', 'category_inactive', 'no_active_offer']);
    expect(placeTypeHiddenReasons(chain({ offers: [{ active: false, typeActive: true }] }))).toEqual([
      'no_active_offer',
    ]);
  });

  it('le lieu « Autre » est dispensé d’offre (R-CA-05)', () => {
    expect(placeTypeHiddenReasons(chain({ isOther: true, offers: [] }))).toEqual([]);
  });

  it('une offre suit son type, son lieu et sa catégorie', () => {
    const offer = { active: true, typeActive: true, placeTypeActive: true, categoryActive: true };
    expect(offerHiddenReasons(offer)).toEqual([]);
    expect(offerHiddenReasons({ ...offer, active: false, typeActive: false })).toEqual([
      'inactive',
      'type_inactive',
    ]);
    expect(offerHiddenReasons({ ...offer, placeTypeActive: false, categoryActive: false })).toEqual([
      'inactive',
      'category_inactive',
    ]);
  });

  it('catalogue public : catégories sans lieu visible masquées, tri par ordre puis par nom', () => {
    const categories = [
      { id: 'c2', order: 1, name: 'Bureaux', active: true },
      { id: 'c1', order: 0, name: 'Maison', active: true },
      { id: 'c3', order: 2, name: 'Chantier', active: true },
      { id: 'c4', order: 3, name: 'Salle', active: false },
    ];
    const placeTypes = [
      { id: 'studio', categoryId: 'c1', order: 1, name: 'Studio', chain: chain() },
      { id: 'villa', categoryId: 'c1', order: 0, name: 'Villa', chain: chain() },
      { id: 'appart', categoryId: 'c1', order: 0, name: 'Appartement', chain: chain() },
      { id: 'open', categoryId: 'c2', order: 0, name: 'Plateau', chain: chain() },
      { id: 'site', categoryId: 'c3', order: 0, name: 'Site', chain: chain({ active: false }) },
      { id: 'hall', categoryId: 'c4', order: 0, name: 'Salle', chain: chain({ categoryActive: false }) },
    ];
    const catalog = publicCatalog(categories, placeTypes);
    expect(
      catalog.map((entry) => [entry.category.id, entry.placeTypes.map((placeType) => placeType.id)]),
    ).toEqual([
      ['c1', ['appart', 'villa', 'studio']],
      ['c2', ['open']],
    ]);
  });

  it('ordre alphabétique français à ordre égal', () => {
    expect(byDisplayOrder({ order: 0, name: 'Écurie' }, { order: 0, name: 'Garage' })).toBeLessThan(0);
  });
});
