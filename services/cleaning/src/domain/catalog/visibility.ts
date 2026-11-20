/**
 * Visibilité publique en cascade (R-CA-12, reprise RV-25) : un lieu est visible si lui-même et sa
 * catégorie sont actifs et s'il a au moins une offre active dont le type est actif ; le lieu
 * « Autre » est dispensé d'offre. Une catégorie sans lieu visible est masquée. Tri par ordre, puis
 * par nom. Le back-office lit les raisons du masquage.
 */
export type VisibilityReason = 'inactive' | 'category_inactive' | 'no_active_offer' | 'type_inactive';

export interface OfferLink {
  active: boolean;
  typeActive: boolean;
}

export interface PlaceTypeChain {
  active: boolean;
  categoryActive: boolean;
  /** Lieu « Autre » (R-CA-05) : visible sans offre. */
  isOther: boolean;
  offers: readonly OfferLink[];
}

/** Raisons du masquage d'un lieu ; vide : visible. */
export function placeTypeHiddenReasons(chain: PlaceTypeChain): VisibilityReason[] {
  const reasons: VisibilityReason[] = [];
  if (!chain.active) reasons.push('inactive');
  if (!chain.categoryActive) reasons.push('category_inactive');
  if (!chain.isOther && !chain.offers.some((offer) => offer.active && offer.typeActive)) {
    reasons.push('no_active_offer');
  }
  return reasons;
}

/**
 * Raisons du masquage d'une offre ; vide : visible. Interprétation : l'offre suit la chaîne de son
 * lieu (un lieu désactivé masque ses offres, sous la raison `inactive`, faute de valeur dédiée au
 * contrat) ; l'absence d'autre offre active ne la concerne pas.
 */
export function offerHiddenReasons(offer: {
  active: boolean;
  typeActive: boolean;
  placeTypeActive: boolean;
  categoryActive: boolean;
}): VisibilityReason[] {
  const reasons: VisibilityReason[] = [];
  if (!offer.active || !offer.placeTypeActive) reasons.push('inactive');
  if (!offer.categoryActive) reasons.push('category_inactive');
  if (!offer.typeActive) reasons.push('type_inactive');
  return reasons;
}

/** Ordre d'affichage croissant, puis nom (ordre alphabétique français). */
export function byDisplayOrder<T extends { order: number; name: string }>(a: T, b: T): number {
  return a.order - b.order || a.name.localeCompare(b.name, 'fr');
}

/**
 * Catalogue public : catégories actives ayant au moins un lieu visible, avec leurs lieux visibles,
 * le tout trié.
 */
export function publicCatalog<
  C extends { id: string; order: number; name: string; active: boolean },
  P extends { categoryId: string; order: number; name: string; chain: PlaceTypeChain },
>(categories: readonly C[], placeTypes: readonly P[]): { category: C; placeTypes: P[] }[] {
  const visible = placeTypes.filter((placeType) => placeTypeHiddenReasons(placeType.chain).length === 0);
  return [...categories]
    .filter((category) => category.active)
    .sort(byDisplayOrder)
    .map((category) => ({
      category,
      placeTypes: visible.filter((placeType) => placeType.categoryId === category.id).sort(byDisplayOrder),
    }))
    .filter((entry) => entry.placeTypes.length > 0);
}
