/**
 * Composition d'un pack « Nettoyage complet » (R-CA-04) : au moins un type, sans doublon, jamais le
 * pack lui-même. Décision du responsable : un pack ne contient jamais un autre pack, et un type déjà
 * contenu dans un pack ne devient pas un pack (`not_applicable` dans les deux cas). Un type qui n'est
 * pas un pack ne porte aucun type contenu.
 */
export const MAX_PACK_ITEMS = 20;

/** Type proposé comme contenu du pack. */
export interface PackItemCandidate {
  id: string;
  isPack: boolean;
}

export interface PackComposition {
  /** Identifiant du type enregistré ; null à la création. */
  typeId: string | null;
  isPack: boolean;
  items: readonly PackItemCandidate[];
  /** Le type figure déjà dans un autre pack. */
  containedInPack: boolean;
}

export type PackProblemReason = 'required' | 'duplicate' | 'not_applicable' | 'out_of_range';

export interface PackProblem {
  field: string;
  reason: PackProblemReason;
}

export function packCompositionProblems(composition: PackComposition): PackProblem[] {
  const { items } = composition;
  if (!composition.isPack) {
    return items.length ? [{ field: 'packItemIds', reason: 'not_applicable' }] : [];
  }
  const problems: PackProblem[] = [];
  if (composition.containedInPack) problems.push({ field: 'isPack', reason: 'not_applicable' });
  if (!items.length) problems.push({ field: 'packItemIds', reason: 'required' });
  if (items.length > MAX_PACK_ITEMS) problems.push({ field: 'packItemIds', reason: 'out_of_range' });
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const field = `packItemIds[${index}]`;
    if (seen.has(item.id)) problems.push({ field, reason: 'duplicate' });
    else if (item.id === composition.typeId || item.isPack)
      problems.push({ field, reason: 'not_applicable' });
    seen.add(item.id);
  });
  return problems;
}
