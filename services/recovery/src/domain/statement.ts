import { localDay, type LocalDay, localInstant } from './calendar';
import { type CollectionSource, type CommissionSettlement } from './collection';

/**
 * Relevé mensuel d'un dossier (R-CO-05, ADR-060 point 11 ; message `Statement` du contrat) : pour un
 * mois du Bénin, les encaissements crédités au portefeuille du créancier pendant ce mois, la
 * commission retenue, les frais retenus et le net reversé. Chaque encaissement est crédité une fois :
 * il figure sur un seul relevé, celui du mois de son crédit (un crédit repris tard par la tâche passe
 * au mois suivant, rien n'est perdu ni compté deux fois). Un paiement reçu directement par le
 * créancier n'y figure pas : rien n'est reversé, sa commission est sur la facture de billing.
 */

/** Mois « AAAA-MM », heure du Bénin. */
export type Period = string;

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(value: string): boolean {
  return PERIOD.test(value);
}

/** Mois du Bénin d'un instant. */
export function periodOf(instant: Date): Period {
  return localDay(instant).slice(0, 7);
}

/** Mois précédent (« 2027-01 » → « 2026-12 »). */
export function previousPeriod(period: Period): Period {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** Bornes du mois : du 1er à 00:00 inclus au 1er du mois suivant exclu, heure du Bénin. */
export function periodBounds(period: Period): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return { start: localInstant(`${period}-01`, 0), end: localInstant(`${next}-01`, 0) };
}

/**
 * Mois à relever au passage de la tâche : les mois écoulés, le plus récent d'abord. Le relevé d'un
 * mois se produit dès le 1er du mois suivant (comme la facture de commission de billing) ; les
 * `catchUp` mois d'avant sont repris si la tâche n'a pas tourné.
 */
export function periodsToState(now: Date, catchUp: number): Period[] {
  const periods: Period[] = [];
  let period = previousPeriod(periodOf(now));
  for (let index = 0; index <= catchUp; index += 1) {
    periods.push(period);
    period = previousPeriod(period);
  }
  return periods;
}

/** Encaissement tel que le relevé le lit (table `collections`). */
export interface StatedCollection {
  id: string;
  source: CollectionSource;
  settlement: CommissionSettlement;
  gross: number;
  overpaid: number;
  commission: number;
  net: number;
  creditedAt: Date | null;
}

/** Ligne du relevé : jour du crédit, encaissé, commission, frais retenus, reversé. */
export interface StatementMovement {
  collectionId: string;
  day: LocalDay;
  source: CollectionSource;
  collected: number;
  commission: number;
  costs: number;
  remitted: number;
}

export interface StatementTotals {
  collected: number;
  commission: number;
  costs: number;
  remitted: number;
}

/**
 * Mouvements d'un relevé : encaissements crédités pendant le mois, dans l'ordre des crédits. Encaissé :
 * part du créancier (brut hors trop-perçu, remboursé au débiteur) ; reversé : net crédité. Frais
 * retenus : aucun, KSP n'avance jamais de frais de procédure (ADR-060 point 10 ; les frais recouvrés
 * sont rendus au créancier dans le net) : encaissé − commission − frais = reversé.
 */
export function statementMovements(
  collections: readonly StatedCollection[],
  period: Period,
): { movements: StatementMovement[]; totals: StatementTotals } {
  const { start, end } = periodBounds(period);
  const movements = collections
    .filter(
      (collection) =>
        collection.settlement === 'deducted' &&
        collection.creditedAt !== null &&
        collection.creditedAt >= start &&
        collection.creditedAt < end &&
        collection.gross - collection.overpaid > 0,
    )
    .sort((a, b) => a.creditedAt!.getTime() - b.creditedAt!.getTime() || a.id.localeCompare(b.id))
    .map((collection) => {
      const collected = collection.gross - collection.overpaid;
      return {
        collectionId: collection.id,
        day: localDay(collection.creditedAt!),
        source: collection.source,
        collected,
        commission: collection.commission,
        costs: 0,
        remitted: collection.net,
      };
    });
  const totals = movements.reduce<StatementTotals>(
    (sum, movement) => ({
      collected: sum.collected + movement.collected,
      commission: sum.commission + movement.commission,
      costs: sum.costs + movement.costs,
      remitted: sum.remitted + movement.remitted,
    }),
    { collected: 0, commission: 0, costs: 0, remitted: 0 },
  );
  return { movements, totals };
}
