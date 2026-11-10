/**
 * Contrat facturé chaque mois (CDC Nettoyage, partie 10, décisions du 2026-10-23), appris par
 * l'événement cleaning.booking.confirmed d'une organisation.
 *
 * - Une facture par mois civil, à l'heure du Bénin (UTC+1, sans heure d'été), émise à la fin du
 *   mois : le 1er du mois suivant à 00:00 heure du Bénin (fin du mois écoulé).
 * - Prorata des jours : montant mensuel (total / durée) × jours facturables / jours du mois,
 *   arrondi à l'entier XOF. Le premier et le dernier mois partiels sont donc proratisés, et les
 *   jours de suspension sont déduits de la même façon.
 * - Le dernier mois du contrat absorbe l'écart d'arrondi : hors suspension, la somme des
 *   factures vaut exactement le total. Un contrat annulé s'arrête au jour de l'annulation, sans
 *   absorption.
 * - Prestation ponctuelle (ADR-049) : facturée en une fois, en entier, sur la facture du mois de
 *   son passage ; rien si elle est annulée avant son jour.
 */
export type BillingSource = 'cleaning';

export interface SuspensionInterval {
  from: Date;
  to: Date;
}

export interface BillingContract {
  /** Identifiant du contrat chez la source (cleaning : la mission). */
  id: string;
  source: BillingSource;
  customerId: string;
  organizationId: string | null;
  total: number;
  durationMonths: number;
  startsAt: Date;
  terminatedAt: Date | null;
  suspendedSince: Date | null;
  suspensions: SuspensionInterval[];
  lastResumedAt: Date | null;
  /**
   * Prestation ponctuelle (sans récurrence, ADR-049) : une seule facture, celle du mois du passage.
   * Absent ou false : contrat récurrent, facturé au prorata des jours (contrats antérieurs compris).
   */
  oneOff?: boolean;
  /**
   * Nom de la prestation au moment de la confirmation (cleaning.booking.confirmed, ADR-035), repris
   * dans le libellé des lignes ; null ou absent : libellé générique.
   */
  serviceName?: string | null;
  createdAt: Date;
}

export interface ContractPeriod {
  /** Rang du mois civil facturé dans le contrat (1 pour le premier). */
  index: number;
  year: number;
  /** Mois civil, 1 à 12. */
  month: number;
  /**
   * Bornes du contrat dans ce mois (minuit, heure du Bénin) : `start` est le premier instant facturé,
   * `end` une borne exclusive (minuit du lendemain du dernier jour facturé).
   */
  start: Date;
  end: Date;
  /** Émission : 1er du mois suivant à 00:00 heure du Bénin. */
  issueAt: Date;
  daysInMonth: number;
  /** Jours du contrat dans ce mois, et jours de suspension parmi eux. */
  contractDays: number;
  suspendedDays: number;
  amount: number;
}

const DAY_MS = 86_400_000;
/** Heure du Bénin : UTC+1, toute l'année. */
const BENIN_OFFSET_MS = 3_600_000;

/** Jour civil au Bénin, compté depuis le 1970-01-01 (Bénin). */
export function beninDay(date: Date): number {
  return Math.floor((date.getTime() + BENIN_OFFSET_MS) / DAY_MS);
}

/** Minuit (heure du Bénin) du jour donné, en instant UTC. */
export function beninMidnight(day: number): Date {
  return new Date(day * DAY_MS - BENIN_OFFSET_MS);
}

const dayOf = (year: number, monthIndex: number) => Date.UTC(year, monthIndex, 1) / DAY_MS;

/**
 * Ajoute des mois au calendrier du Bénin (ADR-049), heure conservée ; le jour est ramené au dernier
 * jour du mois si besoin (31 → 28). En jours UTC, une date de fin de soirée (23:00 UTC et après,
 * déjà le lendemain au Bénin) tomberait un jour trop loin.
 */
export function addMonths(date: Date, months: number): Date {
  const local = new Date(date.getTime() + BENIN_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const shifted = Date.UTC(
    year,
    month,
    Math.min(local.getUTCDate(), lastDay),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(shifted - BENIN_OFFSET_MS);
}

/** Fin naturelle du contrat : début + durée en mois. */
export function naturalEnd(contract: Pick<BillingContract, 'startsAt' | 'durationMonths'>): Date {
  return addMonths(contract.startsAt, contract.durationMonths);
}

/** Jours suspendus du contrat (en jours du Bénin), suspension en cours comprise. */
function suspendedDaySet(
  contract: Pick<BillingContract, 'suspensions' | 'suspendedSince'>,
  from: number,
  to: number,
) {
  const intervals = contract.suspensions.map((interval) => [beninDay(interval.from), beninDay(interval.to)]);
  if (contract.suspendedSince) intervals.push([beninDay(contract.suspendedSince), Number.POSITIVE_INFINITY]);
  let count = 0;
  for (let day = from; day < to; day += 1) {
    if (intervals.some(([start, end]) => day >= start! && day < end!)) count += 1;
  }
  return count;
}

/**
 * Mois civils du contrat avec leur montant. Les jours de suspension connus au moment du calcul
 * sont déduits ; la suspension en cours compte jusqu'à la fin de chaque mois concerné.
 */
export function contractPeriods(contract: BillingContract): ContractPeriod[] {
  if (contract.oneOff) return oneOffPeriods(contract);
  const firstDay = beninDay(contract.startsAt);
  const natural = beninDay(naturalEnd(contract));
  const terminated = contract.terminatedAt ? beninDay(contract.terminatedAt) : null;
  const lastDay = terminated !== null ? Math.min(natural, terminated) : natural;
  const runsToTerm = terminated === null || terminated >= natural;
  if (lastDay <= firstDay) return [];

  const start = new Date(firstDay * DAY_MS);
  let year = start.getUTCFullYear();
  let monthIndex = start.getUTCMonth();
  const periods: ContractPeriod[] = [];
  let billedBeforeLast = 0;
  // Montant mensuel exact (fractionnaire) : arrondi seulement au niveau de chaque facture.
  const perMonth = contract.total / contract.durationMonths;

  while (dayOf(year, monthIndex) < lastDay) {
    const monthStart = dayOf(year, monthIndex);
    const monthEnd = dayOf(year, monthIndex + 1);
    const daysInMonth = monthEnd - monthStart;
    const from = Math.max(firstDay, monthStart);
    const to = Math.min(lastDay, monthEnd);
    const contractDays = to - from;
    const suspendedDays = suspendedDaySet(contract, from, to);
    const isLast = to === lastDay;
    const full =
      isLast && runsToTerm
        ? contract.total - billedBeforeLast
        : Math.round((perMonth * contractDays) / daysInMonth);
    const deduction = Math.round((perMonth * suspendedDays) / daysInMonth);
    billedBeforeLast += full;
    periods.push({
      index: periods.length + 1,
      year: new Date(monthStart * DAY_MS).getUTCFullYear(),
      month: new Date(monthStart * DAY_MS).getUTCMonth() + 1,
      start: beninMidnight(from),
      end: beninMidnight(to),
      issueAt: beninMidnight(monthEnd),
      daysInMonth,
      contractDays,
      suspendedDays,
      amount: Math.max(0, full - deduction),
    });
    monthIndex += 1;
    if (monthIndex === 12) {
      monthIndex = 0;
      year += 1;
    }
  }
  return periods;
}

/**
 * Prestation ponctuelle : le total en entier, sur le mois civil (Bénin) du jour du passage, émis à la
 * fin de ce mois. Annulée ce jour-là ou avant : rien à facturer. Une suspension n'en déduit rien : le
 * passage est fait ou la mission est annulée.
 */
function oneOffPeriods(contract: BillingContract): ContractPeriod[] {
  const day = beninDay(contract.startsAt);
  if (contract.terminatedAt && beninDay(contract.terminatedAt) <= day) return [];
  const date = new Date(day * DAY_MS);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const monthStart = dayOf(year, monthIndex);
  const monthEnd = dayOf(year, monthIndex + 1);
  return [
    {
      index: 1,
      year,
      month: monthIndex + 1,
      start: beninMidnight(day),
      end: beninMidnight(day + 1),
      issueAt: beninMidnight(monthEnd),
      daysInMonth: monthEnd - monthStart,
      contractDays: 1,
      suspendedDays: 0,
      amount: contract.total,
    },
  ];
}

/**
 * Mois à facturer maintenant : mois civil écoulé (émission le 1er à 00:00, heure du Bénin), pas
 * encore facturé, et de montant non nul (un mois entièrement suspendu n'est pas facturé).
 */
export function duePeriods(
  contract: BillingContract,
  invoicedIndexes: ReadonlySet<number>,
  now: Date,
): ContractPeriod[] {
  return contractPeriods(contract).filter(
    (period) => period.issueAt <= now && !invoicedIndexes.has(period.index) && period.amount > 0,
  );
}

/** Suspension annoncée par cleaning ; un événement arrivé après la reprise est replacé dans l'historique. */
export function applySuspension(contract: BillingContract, at: Date): BillingContract {
  if (contract.suspendedSince) return contract;
  if (contract.lastResumedAt && at < contract.lastResumedAt) {
    return { ...contract, suspensions: [...contract.suspensions, { from: at, to: contract.lastResumedAt }] };
  }
  return { ...contract, suspendedSince: at };
}

export function applyResumption(contract: BillingContract, at: Date): BillingContract {
  const lastResumedAt = contract.lastResumedAt && contract.lastResumedAt > at ? contract.lastResumedAt : at;
  if (!contract.suspendedSince) return { ...contract, lastResumedAt };
  return {
    ...contract,
    suspendedSince: null,
    lastResumedAt,
    suspensions: [...contract.suspensions, { from: contract.suspendedSince, to: at }],
  };
}
