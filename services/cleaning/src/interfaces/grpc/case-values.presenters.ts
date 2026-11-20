import { type cleaningV1 } from '@ksp/contracts';
import { type PlaceView } from '../../application/requests/places.use-cases';
import { type PlainLocation } from '../../application/requests/locations';
import { type DeclaredValues } from '../../application/requests/requests.ports';
import { type ParameterValue } from '../../domain/pricing/types';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type StoredPhoto } from '../../application/ports';

/** Valeurs simples du dossier → messages du contrat. */
export const isoOf = (date: Date | null | undefined) => (date ? date.toISOString() : undefined);
export const opt = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export function parameterValue(
  value: ParameterValue | null | undefined,
): cleaningV1.ParameterValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return { number: value };
  if (typeof value === 'boolean') return { flag: value };
  return { choice: value };
}

export function parameterValues(
  values: DeclaredValues | null | undefined,
): Record<string, cleaningV1.ParameterValue> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([code, value]) => [
      code,
      parameterValue(value) as cleaningV1.ParameterValue,
    ]),
  );
}

/** Valeurs reçues (oneof) : nombre, code de choix ou oui/non ; les valeurs vides sont ignorées. */
export function declaredFromProto(values: Record<string, cleaningV1.ParameterValue>): DeclaredValues {
  const result: DeclaredValues = {};
  for (const [code, value] of Object.entries(values)) {
    const plain = value.number ?? value.choice ?? value.flag;
    if (plain !== undefined) result[code] = plain;
  }
  return result;
}

export function schedulePlan(plan: SchedulePlan): cleaningV1.SchedulePlan {
  return {
    kind: plan.kind,
    startTime: plan.startTime,
    dates: plan.dates,
    weekdays: plan.weekdays,
    everyWeeks: opt(plan.everyWeeks),
    monthDays: plan.monthDays,
    monthWeekdays: plan.monthWeekdays.map((entry) => ({ rank: entry.rank, weekday: entry.weekday })),
    startDate: opt(plan.startDate),
    endDate: opt(plan.endDate),
    durationWeeks: opt(plan.durationWeeks),
    durationMonths: opt(plan.durationMonths),
    excludedDates: plan.excludedDates,
    addedDates: plan.addedDates,
    excludeHolidays: opt(plan.excludeHolidays),
  };
}

export function placeLocation(location: PlainLocation | null): cleaningV1.PlaceLocation | undefined {
  if (!location) return undefined;
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    landmark: location.landmark ?? '',
    address: opt(location.address),
    readableAddress: opt(location.readableAddress),
    accuracyMeters: opt(location.accuracyM),
  };
}

export function presentPlace(view: PlaceView): cleaningV1.Place {
  const { place } = view;
  return {
    id: place.id,
    name: place.name,
    placeTypeId: place.placeTypeId,
    placeTypeName: view.placeTypeName,
    communeKey: place.communeKey,
    communeName: view.communeName,
    served: view.served,
    location: placeLocation(view.location),
    declaredValues: parameterValues(place.declaredValues),
    archived: place.archivedAt !== null,
    createdAt: place.createdAt.toISOString(),
    updatedAt: place.updatedAt.toISOString(),
    locationCorrectedAt: isoOf(place.locationCorrectedAt),
    locationErasedAt: isoOf(place.locationErasedAt),
  };
}

/** Photos rattachées chez file, avec leurs adresses de lecture temporaires. */
export function photos(
  fileIds: readonly string[],
  stored: readonly StoredPhoto[],
  kind: string,
): cleaningV1.Photo[] {
  return fileIds.map((fileId) => {
    const found = stored.find((photo) => photo.fileId === fileId);
    return {
      fileId,
      kind,
      takenAt: found ? found.uploadedAt.toISOString() : '',
      url: opt(found?.downloadUrl),
      urlExpiresAt: isoOf(found?.downloadExpiresAt ?? null),
    };
  });
}
