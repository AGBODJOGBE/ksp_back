import { type ParameterValue } from '../../domain/pricing/types';
import {
  buildComparison,
  type Comparison,
  prefillObserved,
  saveRetained,
  type ValueReason,
} from '../../domain/visits/observation';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { type SimulationResult } from '../simulation/simulate.use-cases';
import { requireUuid } from '../shared/input';
import { decide } from './case-errors';
import { priceCase, priceEffects } from './case-pricing';
import { audit, currentVisit, effectiveStatus, saveCase, staffCase } from './case-support';
import { type CaseRecord, type RevisionRecord } from './requests.ports';
import { CASE_PERMISSIONS, staffWith } from './staff';

/**
 * UC-NT-32 — Version retenue (partie 7.4, R-CS-01 à R-CS-04, RV-59) : valeurs finales du devis,
 * chiffrées aux tarifs publiés du jour, motif pour chaque écart avec le constat, révision ouverte
 * modifiée en place ou nouvelle révision après l'envoi d'un devis.
 */
export interface RetainedInput {
  requestId: string;
  values: Record<string, ParameterValue>;
  cleaningTypeIds: string[];
  reasons?: { parameterCode?: string | undefined; cleaningTypeId?: string | undefined; reason: string }[];
  reason?: string | undefined;
}

/** Constat de l'agent (version « constaté ») ; à défaut, le déclaré (7.4). */
export function observedOf(record: CaseRecord): Record<string, ParameterValue> {
  const visit = currentVisit(record);
  return (
    (visit?.observedValues as Record<string, ParameterValue> | null) ?? {
      ...prefillObserved({
        values: record.request.declaredValues,
        cleaningTypeIds: record.request.cleaningTypeIds,
      }),
    }
  );
}

/** R-CS-02 : comparaison déclaré / constaté / retenu, effet de chaque écart sur le prix. */
export async function comparisonOf(
  deps: CleaningDeps,
  record: CaseRecord,
  revision: Pick<RevisionRecord, 'values' | 'cleaningTypeIds' | 'sessionPrice'>,
): Promise<Comparison> {
  return buildComparison({
    declared: {
      values: record.request.declaredValues,
      cleaningTypeIds: record.request.cleaningTypeIds,
      sessionPrice: record.request.estimatedSessionPrice ?? 0,
    },
    observed: currentVisit(record)?.observedValues ?? null,
    retained: { ...revision, values: revision.values },
    priceEffects: await priceEffects(deps, record, revision.values as Record<string, ParameterValue>),
  });
}

export class RetainedValuesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** EstimateRetainedValues (R-CS-04) : calcul à blanc, rien n'est enregistré. */
  async estimate(
    input: Omit<RetainedInput, 'reasons' | 'reason'>,
  ): Promise<{ result: SimulationResult; record: CaseRecord }> {
    requireStaff();
    const record = await staffCase(this.deps, input.requestId);
    staffWith(CASE_PERMISSIONS.quoteManage, record.request.communeKey);
    const cleaningTypeIds = input.cleaningTypeIds.map((id, index) =>
      requireUuid(id, `cleaningTypeIds[${index}]`),
    );
    return { result: await priceCase(this.deps, record, { values: input.values, cleaningTypeIds }), record };
  }

  /** SaveRetainedValues : « visite faite » modifie la révision ouverte ; « devis envoyé » en crée une. */
  async save(
    input: RetainedInput,
  ): Promise<{ record: CaseRecord; revision: RevisionRecord; comparison: Comparison }> {
    requireStaff();
    const record = await staffCase(this.deps, input.requestId);
    const staffId = staffWith(CASE_PERMISSIONS.quoteManage, record.request.communeKey);
    const cleaningTypeIds = input.cleaningTypeIds.map((id, index) =>
      requireUuid(id, `cleaningTypeIds[${index}]`),
    );
    const now = this.deps.clock.now();
    const priced = await priceCase(this.deps, record, { values: input.values, cleaningTypeIds });
    const sessionPrice = priced.pricing.sessionPrice ?? priced.pricing.pricedSubtotal ?? 0;
    const reasons: ValueReason[] = (input.reasons ?? []).map((item) => ({
      parameterCode: item.parameterCode ?? null,
      cleaningTypeId: item.cleaningTypeId ?? null,
      reason: item.reason,
    }));
    const visit = currentVisit(record);
    const saved = decide(() =>
      saveRetained({
        requestStatus: effectiveStatus(record, now),
        revisions: record.revisions,
        currentVisitId: visit?.id ?? null,
        observed: observedOf(record),
        declaredCleaningTypeIds: record.request.cleaningTypeIds,
        input: { values: input.values, cleaningTypeIds, reasons, reason: input.reason ?? null, sessionPrice },
        authorId: staffId,
        now,
      }),
    );
    const comparison = await comparisonOf(this.deps, record, saved.saved);
    const known = new Map(record.revisions.map((revision) => [revision.revision, revision]));
    const revisions: RevisionRecord[] = saved.revisions.map((revision) => {
      const previous = known.get(revision.revision);
      const isSaved = revision.revision === saved.saved.revision;
      return {
        ...revision,
        id: previous?.id ?? this.deps.ids.next(),
        reasons: [...revision.reasons],
        pricingSnapshot: isSaved ? priced.pricing : (previous?.pricingSnapshot ?? null),
        diff: isSaved ? comparison.rows : (previous?.diff ?? []),
      };
    });
    const next: CaseRecord = { ...record, request: { ...record.request, updatedAt: now }, revisions };
    const after = await saveCase(this.deps, next, record.request.version, {
      changes: {
        events: [],
        audit: [
          audit(staffId, 'request.retained_saved', 'request', record.request.id, now, {
            revision: saved.saved.revision,
            sessionPrice,
          }),
        ],
      },
    });
    return {
      record: after,
      revision: revisions.find((item) => item.revision === saved.saved.revision)!,
      comparison,
    };
  }
}
