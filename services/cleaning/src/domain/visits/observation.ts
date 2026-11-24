import { DomainRuleError, invalidTransition, requireReason } from '../requests/errors';
import { type RequestStatus } from '../requests/request-status';

/**
 * Constat (partie 7.4) : trois versions des informations du lieu. Le déclaré (client, figé à
 * l'envoi), le constaté (agent, prérempli avec le déclaré), le retenu (supervision, valeurs finales du
 * devis, versionné par révisions, RV-59). Les prix viennent du domaine du prix (lot A) : ce module
 * reçoit des montants déjà calculés et ne chiffre rien.
 */
export type ParameterValue = number | string | boolean;
export type ParameterValues = Readonly<Record<string, ParameterValue>>;

/** Valeurs par code de paramètre et types de nettoyage choisis. */
export interface CaseValues {
  values: ParameterValues;
  cleaningTypeIds: readonly string[];
}

/** Motif d'un écart avec le constat : un paramètre, ou un type ajouté ou retiré. */
export interface ValueReason {
  parameterCode?: string | null;
  cleaningTypeId?: string | null;
  reason: string;
}

/** Révision de la version retenue (RetainedValues). */
export interface RetainedRevision extends CaseValues {
  revision: number;
  /** Motif de la révision, obligatoire à partir de la deuxième. */
  reason: string | null;
  /** Visite dont le constat a servi de point de départ. */
  visitId: string | null;
  reasons: readonly ValueReason[];
  /** Prix d'une séance du calcul retenu (lot A). */
  sessionPrice: number;
  authorId: string;
  /** Figée par l'envoi d'un devis (R-CS-03) ; null tant qu'elle est ouverte. */
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Le constaté part du déclaré (7.4). */
export function prefillObserved(declared: CaseValues): ParameterValues {
  return { ...declared.values };
}

function sameValue(a: ParameterValue | undefined, b: ParameterValue | undefined): boolean {
  return a === b;
}

function orderedKeys(...sources: Array<ParameterValues | null | undefined>): string[] {
  const keys: string[] = [];
  for (const source of sources) {
    for (const key of Object.keys(source ?? {})) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export interface Deviations {
  parameterCodes: string[];
  addedCleaningTypeIds: string[];
  removedCleaningTypeIds: string[];
}

/** Écarts du retenu avec le constat : chacun exige un motif (7.4). */
export function retainedDeviations(
  observed: ParameterValues,
  observedCleaningTypeIds: readonly string[],
  retained: CaseValues,
): Deviations {
  return {
    parameterCodes: orderedKeys(observed, retained.values).filter(
      (code) => !sameValue(observed[code], retained.values[code]),
    ),
    addedCleaningTypeIds: retained.cleaningTypeIds.filter((id) => !observedCleaningTypeIds.includes(id)),
    removedCleaningTypeIds: observedCleaningTypeIds.filter((id) => !retained.cleaningTypeIds.includes(id)),
  };
}

export function assertDeviationReasons(deviations: Deviations, reasons: readonly ValueReason[]): void {
  const explained = (match: (reason: ValueReason) => boolean) =>
    reasons.some((reason) => match(reason) && reason.reason.trim().length > 0);
  const missing = [
    ...deviations.parameterCodes.filter((code) => !explained((reason) => reason.parameterCode === code)),
    ...[...deviations.addedCleaningTypeIds, ...deviations.removedCleaningTypeIds].filter(
      (id) => !explained((reason) => reason.cleaningTypeId === id),
    ),
  ];
  if (missing.length > 0)
    throw new DomainRuleError('CLEANING_REASON_REQUIRED', { field: 'reasons', missing });
}

/** R-CS-01 : retenu identique au déclaré, mêmes paramètres et mêmes types. */
export function isRetainedConfirmed(declared: CaseValues, retained: CaseValues): boolean {
  const keys = orderedKeys(declared.values, retained.values);
  const sameTypes =
    declared.cleaningTypeIds.length === retained.cleaningTypeIds.length &&
    declared.cleaningTypeIds.every((id) => retained.cleaningTypeIds.includes(id));
  return sameTypes && keys.every((key) => sameValue(declared.values[key], retained.values[key]));
}

export interface ComparisonRow {
  parameterCode: string;
  declared: ParameterValue | null;
  observed: ParameterValue | null;
  retained: ParameterValue | null;
  /** Retenu différent du déclaré. */
  changed: boolean;
  /** Écart numérique retenu − déclaré ; null pour un choix, un booléen ou une valeur absente. */
  delta: number | null;
  /** Effet sur le prix d'une séance (lot A) ; 0 sans effet connu. */
  priceEffect: number;
}

export interface Comparison {
  /** « Informations confirmées » (R-CS-01). */
  confirmed: boolean;
  rows: ComparisonRow[];
  addedCleaningTypeIds: string[];
  removedCleaningTypeIds: string[];
  declaredSessionPrice: number;
  retainedSessionPrice: number;
}

/**
 * R-CS-02 : tableau montré au client, une ligne par paramètre (déclaré, constaté, retenu, écart, effet
 * sur le prix), types ajoutés ou retirés par la supervision. `priceEffects` : effet de chaque
 * paramètre sur le prix d'une séance, fourni par le domaine du prix.
 */
export function buildComparison(input: {
  declared: CaseValues & { sessionPrice: number };
  observed: ParameterValues | null;
  retained: CaseValues & { sessionPrice: number };
  priceEffects?: Readonly<Record<string, number>>;
}): Comparison {
  const { declared, observed, retained } = input;
  const rows = orderedKeys(declared.values, retained.values, observed).map((code): ComparisonRow => {
    const before = declared.values[code];
    const after = retained.values[code];
    return {
      parameterCode: code,
      declared: before ?? null,
      observed: observed?.[code] ?? null,
      retained: after ?? null,
      changed: !sameValue(before, after),
      delta: typeof before === 'number' && typeof after === 'number' ? after - before : null,
      priceEffect: input.priceEffects?.[code] ?? 0,
    };
  });
  return {
    confirmed: isRetainedConfirmed(declared, retained),
    rows,
    addedCleaningTypeIds: retained.cleaningTypeIds.filter((id) => !declared.cleaningTypeIds.includes(id)),
    removedCleaningTypeIds: declared.cleaningTypeIds.filter((id) => !retained.cleaningTypeIds.includes(id)),
    declaredSessionPrice: declared.sessionPrice,
    retainedSessionPrice: retained.sessionPrice,
  };
}

/** R-CS-01 / R-CS-02 : prix de base du devis, celui du simulateur si les informations sont confirmées. */
export function quoteBaseSessionPrice(comparison: Comparison): number {
  return comparison.confirmed ? comparison.declaredSessionPrice : comparison.retainedSessionPrice;
}

/**
 * Enregistrer le retenu (SaveRetainedValues, RV-59). « Visite faite » : modifie la révision ouverte de
 * la visite en cours. « Devis envoyé » : la révision du devis envoyé est figée ; une nouvelle révision
 * est créée avec un motif, puis modifiée en place jusqu'à l'envoi de la révision du devis.
 * Interprétation de R-VI-07 : après une nouvelle visite, la révision encore ouverte de la visite
 * précédente est close (figée) et une nouvelle s'ouvre, avec un motif.
 */
export function saveRetained(input: {
  requestStatus: RequestStatus;
  revisions: readonly RetainedRevision[];
  currentVisitId: string | null;
  observed: ParameterValues;
  declaredCleaningTypeIds: readonly string[];
  input: CaseValues & { reasons: readonly ValueReason[]; reason?: string | null; sessionPrice: number };
  authorId: string;
  now: Date;
}): { revisions: RetainedRevision[]; saved: RetainedRevision } {
  const { requestStatus: status, now } = input;
  if (status !== 'visit_done' && status !== 'quote_sent') throw invalidTransition(status, status);
  const values = input.input;
  assertDeviationReasons(
    retainedDeviations(input.observed, input.declaredCleaningTypeIds, values),
    values.reasons,
  );
  const content = {
    values: values.values,
    cleaningTypeIds: values.cleaningTypeIds,
    reasons: values.reasons,
    sessionPrice: values.sessionPrice,
    authorId: input.authorId,
    updatedAt: now,
  };
  const newReason = values.reason?.trim() || null;
  const open = input.revisions.find((revision) => revision.lockedAt === null);
  if (open && (status === 'quote_sent' || open.visitId === input.currentVisitId)) {
    const saved: RetainedRevision = { ...open, ...content, reason: newReason ?? open.reason };
    return { revisions: input.revisions.map((revision) => (revision === open ? saved : revision)), saved };
  }
  const number = input.revisions.reduce((max, revision) => Math.max(max, revision.revision), 0) + 1;
  const saved: RetainedRevision = {
    ...content,
    revision: number,
    reason: number > 1 ? requireReason(values.reason) : newReason,
    visitId: input.currentVisitId,
    lockedAt: null,
    createdAt: now,
  };
  const closed = input.revisions.map((revision) =>
    revision === open ? { ...revision, lockedAt: now } : revision,
  );
  return { revisions: [...closed, saved], saved };
}

/** R-CS-03 : l'envoi d'un devis fige la révision qu'il cite ; déjà figée, elle garde sa date. */
export function lockRevision(
  revisions: readonly RetainedRevision[],
  number: number,
  now: Date,
): RetainedRevision[] {
  if (!revisions.some((revision) => revision.revision === number)) throw invalidTransition('draft', 'sent');
  return revisions.map((revision) =>
    revision.revision === number && revision.lockedAt === null ? { ...revision, lockedAt: now } : revision,
  );
}
