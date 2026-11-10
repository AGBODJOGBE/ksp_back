import { AppError } from '@ksp/platform';
import { z } from 'zod';

/**
 * Corps et paramètres des routes du Nettoyage, repris du contrat OpenAPI (components/schemas) :
 * tout champ inconnu est refusé. Un test vérifie que les champs et les champs obligatoires
 * restent identiques au contrat. Les règles métier (dates futures, créneaux, prix) restent
 * dans le service cleaning.
 */
const code = z.string().regex(/^[a-z][a-z0-9_]{1,49}$/);
const dateTime = z.iso.datetime({ offset: true });
const uuid = z.guid();
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const text = (max: number, min = 1) => z.string().min(min).max(max);
const slot = z.strictObject({ start: dateTime, end: dateTime });
const recurrence = z.strictObject({
  period: z.enum(['week', 'month']),
  visitsPerPeriod: int(1, 31),
  durationMonths: int(1, 36),
});
/**
 * Plan de passages (ADR-052) : forme seulement ; les règles (champs de chaque mode, période, nombre
 * de passages, délai minimum) sont dans cleaning.
 */
const day = z.iso.date();
const schedule = z.strictObject({
  mode: z.enum(['dates', 'weekly', 'monthly']),
  dates: z.array(day).min(1).max(1000).optional(),
  startDate: day.optional(),
  endDate: day.optional(),
  weekdays: z
    .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
    .min(1)
    .max(7)
    .optional(),
  everyWeeks: int(1, 12).optional(),
  monthDays: z.array(int(1, 31)).min(1).max(31).optional(),
  weeksOfMonth: z
    .array(z.union([int(1, 4), z.literal('last')]))
    .min(1)
    .max(5)
    .optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  excludedDates: z.array(day).max(400).optional(),
  extraDates: z.array(day).max(100).optional(),
});
const nullableAmount = z.number().int().min(0).nullable();
const optionalReason = z.strictObject({ reason: text(500, 0).optional() });
const requiredReason = z.strictObject({ reason: text(500) });
const team = z.strictObject({ name: text(100), memberIds: z.array(uuid).max(50) });

// --- Formulaire paramétrable (ADR-033) -----------------------------------------------------------

const PREMISES_TYPES = ['apartment', 'house', 'office', 'shop', 'warehouse', 'other'] as const;
const LEGACY_FREQUENCIES = ['once', 'weekly', 'monthly'] as const;
const nullableCoefficient = int(1, 100_000).nullable();

/** Réponses : code de champ → entier, code de valeur ou booléen ; 50 au plus. */
const answers = z
  .record(code, z.union([int(0, 1_000_000), code, z.boolean()]))
  .refine((value) => Object.keys(value).length <= 50, { message: '50 réponses au plus' });
const optionSelection = z.strictObject({ code, answers: answers.optional() });

/**
 * Deux formats (ADR-033), distingués par la présence de `answers` : nouveau (options en objets),
 * ou ancien déprécié (type de local et quantité obligatoires, options en codes, fréquence parmi
 * once, weekly, monthly). Les deux ne se mélangent pas.
 */
const formAnswers = {
  answers: answers.optional(),
  options: z
    .array(z.union([optionSelection, code]))
    .max(20)
    .optional(),
  frequency: code.optional(),
  premisesType: z.enum(PREMISES_TYPES).optional(),
  quantity: int(1, 1_000_000).optional(),
};
type FormAnswers = {
  answers?: unknown;
  options?: (string | object)[] | undefined;
  frequency?: string | undefined;
  premisesType?: string | undefined;
  quantity?: number | undefined;
};
function oneFormat(value: FormAnswers, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  const options = value.options ?? [];
  if (value.answers !== undefined) {
    if (value.premisesType !== undefined) issue('premisesType', 'Ancien format : à ne pas mêler à answers.');
    if (value.quantity !== undefined) issue('quantity', 'Ancien format : à ne pas mêler à answers.');
    if (options.some((option) => typeof option === 'string'))
      issue('options', 'Options attendues en objets.');
    return;
  }
  if (value.premisesType === undefined) issue('premisesType', 'Obligatoire sans answers.');
  if (value.quantity === undefined) issue('quantity', 'Obligatoire sans answers.');
  if (options.some((option) => typeof option !== 'string')) issue('options', 'Options attendues en codes.');
  if (value.frequency !== undefined && !(LEGACY_FREQUENCIES as readonly string[]).includes(value.frequency)) {
    issue('frequency', 'Ancien format : once, weekly ou monthly.');
  }
}

const FIELD_PROPERTIES = {
  number: ['unitLabel', 'min', 'max', 'pricePerUnit'],
  choice: ['choices'],
  boolean: ['supplementIfYes', 'coefficientBpIfYes'],
} as const;
const fieldInput = z
  .strictObject({
    code,
    label: text(100),
    type: z.enum(['number', 'choice', 'boolean']),
    required: z.boolean(),
    helpText: z.string().max(300).nullable().optional(),
    active: z.boolean(),
    unitLabel: text(30).optional(),
    min: int(0, 1_000_000).optional(),
    max: int(0, 1_000_000).optional(),
    pricePerUnit: nullableAmount.optional(),
    choices: z
      .array(
        z.strictObject({
          code,
          label: text(100),
          supplement: nullableAmount,
          coefficientBp: nullableCoefficient.optional(),
          active: z.boolean(),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    supplementIfYes: nullableAmount.optional(),
    coefficientBpIfYes: nullableCoefficient.optional(),
  })
  .superRefine((field, ctx) => {
    // Propriétés obligatoires du type, propriétés des autres types refusées (contrat OpenAPI).
    const required =
      field.type === 'number' ? FIELD_PROPERTIES.number : field.type === 'choice' ? ['choices'] : [];
    for (const key of required) {
      if (field[key as keyof typeof field] === undefined)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Obligatoire pour ce type.' });
    }
    for (const [type, keys] of Object.entries(FIELD_PROPERTIES)) {
      if (type === field.type) continue;
      for (const key of keys) {
        if (field[key as keyof typeof field] !== undefined)
          ctx.addIssue({ code: 'custom', path: [key], message: 'Propriété d’un autre type.' });
      }
    }
  });
const serviceDefinition = z.strictObject({
  name: text(100),
  description: text(1000, 0).optional(),
  active: z.boolean(),
  fields: z.array(fieldInput).min(1).max(30),
  options: z
    .array(
      z.strictObject({
        code,
        label: text(100),
        description: z.string().max(500).nullable().optional(),
        active: z.boolean(),
        flatPrice: nullableAmount,
        fields: z.array(fieldInput).max(10).optional(),
      }),
    )
    .max(20)
    .optional(),
  pricing: z.strictObject({
    minimumPrice: nullableAmount,
    communeCoefficients: z
      .array(z.strictObject({ commune: text(100), coefficientBp: int(1, 100_000) }))
      .optional(),
    defaultCoefficientBp: int(1, 100_000).optional(),
    frequencies: z
      .array(z.strictObject({ code, label: text(100), coefficientBp: int(1, 100_000), active: z.boolean() }))
      .max(10)
      .optional(),
    teamSize: z
      .strictObject({
        unitsPerAgent: int(1, 1_000_000),
        minAgents: int(1, 50),
        maxAgents: int(1, 50),
        fieldCode: code.nullable().optional(),
      })
      .optional(),
    checklist: z.array(z.strictObject({ code, label: text(200) })).optional(),
  }),
});

// --- Parcours par lieu (ADR-034) ------------------------------------------------------------------

/** Une prestation d'un lieu : nouveau format seulement (answers obligatoire, options en objets). */
const placeItem = {
  serviceCode: code,
  answers,
  options: z.array(optionSelection).max(20).optional(),
  frequency: code.optional(),
};
/** Mesures constatées ou réponses à recalculer (ADR-037) : nouveau format seulement. */
const measurement = {
  answers,
  options: z.array(optionSelection).max(20).optional(),
  frequency: code.optional(),
};
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const cleaningBodies = {
  simulateCleaning: z
    .strictObject({
      serviceCode: code,
      ...formAnswers,
      // Facultative (ADR-034) : sans elle, coefficient neutre et communeApplied = false.
      commune: text(100).optional(),
      // Facultatif (ADR-052) : montant estimé sur le nombre exact de passages.
      schedule: schedule.optional(),
    })
    .superRefine(oneFormat),
  // Plan de passages (ADR-052) : le corps est le plan lui-même.
  previewCleaningSchedule: schedule,
  estimateCleaning: z.strictObject({
    placeType: code,
    commune: text(100).optional(),
    items: z.array(z.strictObject(placeItem)).min(1).max(10),
  }),
  resolveCleaningLocation: z.strictObject({ latitude, longitude }),
  requestCleaningQuoteGroup: z.strictObject({
    placeType: code,
    location: z.strictObject({
      latitude,
      longitude,
      accuracyMeters: z.number().min(0).max(100_000).optional(),
    }),
    landmark: text(500),
    commune: text(100).optional(),
    items: z
      .array(z.strictObject({ ...placeItem, requestedTeamSize: int(1, 50).optional() }))
      .min(1)
      .max(10),
    // Facultatifs avec un plan de passages (ADR-052) ; 1 à 3 sinon (contrôlé par cleaning).
    preferredSlots: z.array(slot).max(3).optional(),
    comment: text(2000, 0).optional(),
    recurrence: recurrence.optional(),
    schedule: schedule.optional(),
  }),
  saveCleaningPlaceType: z.strictObject({
    label: text(100),
    description: text(500, 0).optional(),
    icon: text(50),
    displayOrder: int(0, 10_000),
    active: z.boolean(),
    serviceCodes: z.array(code).max(30),
  }),
  requestCleaningQuote: z
    .strictObject({
      serviceCode: code,
      ...formAnswers,
      commune: text(100),
      address: text(500),
      // Facultatifs avec un plan de passages (ADR-052) ; 1 à 3 sinon (contrôlé par cleaning).
      preferredSlots: z.array(slot).max(3).optional(),
      comment: text(2000, 0).optional(),
      recurrence: recurrence.optional(),
      schedule: schedule.optional(),
      requestedTeamSize: int(1, 50).optional(),
      daysPerWeek: int(1, 7).optional(),
    })
    .superRefine(oneFormat),
  acceptCleaningQuote: z.strictObject({
    slotStart: dateTime,
    // Facultatif : une entreprise règle par sa facture mensuelle ; cleaning l'exige d'un particulier.
    paymentPlan: z
      .strictObject({
        option: z.enum(['deposit', 'full']),
        timing: z.enum(['before', 'after']),
        method: z.enum(['cash', 'mobile_money_offline', 'mobile_money_online']),
      })
      .optional(),
  }),
  // Demandes groupées (ADR-035).
  cancelCleaningRequestGroup: optionalReason,
  acceptCleaningQuoteGroup: z.strictObject({
    slotStart: dateTime,
    paymentPlan: z
      .strictObject({
        option: z.enum(['deposit', 'full']),
        timing: z.enum(['before', 'after']),
        method: z.enum(['cash', 'mobile_money_offline', 'mobile_money_online']),
      })
      .optional(),
  }),
  scheduleCleaningGroupVisit: z.strictObject({
    scheduledAt: dateTime,
    agentId: uuid,
    excludeRequestIds: z.array(uuid).max(10).optional(),
  }),
  completeCleaningGroupVisit: z.strictObject({
    report: text(5000),
    measurements: z
      .array(z.strictObject({ requestId: uuid, ...measurement }))
      .max(10)
      .optional(),
  }),
  rejectCleaningRequestGroup: requiredReason,
  sendCleaningGroupQuotes: z.strictObject({
    // Ignorés pour un devis avec un plan de passages (ADR-052) ; 1 à 3 sinon (contrôlé par cleaning).
    proposedSlots: z.array(slot).max(3).optional(),
    validityDays: int(1, 90).optional(),
    schedule: schedule.optional(),
    quotes: z
      .array(
        z.strictObject({
          requestId: uuid,
          lines: z
            .array(
              z.strictObject({ label: text(200), quantity: int(1, 1_000_000), unitPrice: z.number().int() }),
            )
            .max(50)
            .optional(),
          recurrence: recurrence.optional(),
          teamSize: int(1, 50).optional(),
          durationMinutes: int(1, 1440),
        }),
      )
      .min(1)
      .max(10),
  }),
  scheduleCleaningGroupInterventions: z.strictObject({
    missionIds: z.array(uuid).max(10).optional(),
    scheduledStart: dateTime,
    durationMinutes: int(1, 1440),
    agentIds: z.array(uuid).max(50).optional(),
    teamId: uuid.optional(),
  }),
  correctCleaningRequestLocation: z.strictObject({
    latitude,
    longitude,
    accuracyMeters: z.number().min(0).max(100_000).optional(),
    landmark: text(500).optional(),
    commune: text(100).optional(),
  }),
  deactivateCleaningZone: z.strictObject({ confirm: z.boolean().optional() }),
  declineCleaningQuote: optionalReason,
  cancelCleaningRequest: optionalReason,
  cancelMyCleaningMission: optionalReason,
  /** Part payée depuis le portefeuille prépayé (ADR-046) ; le montant vient de cleaning. */
  payMyCleaningMissionFromWallet: z.strictObject({ part: z.enum(['deposit', 'balance']) }),
  rejectCleaningQuoteRequest: requiredReason,
  scheduleCleaningVisit: z.strictObject({ scheduledAt: dateTime, agentId: uuid }),
  completeCleaningVisit: z.strictObject({
    report: text(5000),
    measurements: z.strictObject(measurement).optional(),
  }),
  estimateCleaningQuoteRequest: z.strictObject(measurement),
  saveCleaningMeasurements: z.strictObject(measurement),
  sendCleaningQuote: z.strictObject({
    lines: z
      .array(z.strictObject({ label: text(200), quantity: int(1, 1_000_000), unitPrice: z.number().int() }))
      .max(50)
      .optional(),
    // Ignorés avec un plan de passages (ADR-052) ; 1 à 3 sinon (contrôlé par cleaning).
    proposedSlots: z.array(slot).max(3).optional(),
    validityDays: int(1, 90).optional(),
    recurrence: recurrence.optional(),
    schedule: schedule.optional(),
    teamSize: int(1, 50).optional(),
    durationMinutes: int(1, 1440),
  }),
  scheduleCleaningIntervention: z.strictObject({
    // Absent : prochaine date du plan de passages (ADR-052).
    scheduledStart: dateTime.optional(),
    durationMinutes: int(1, 1440),
    agentIds: z.array(uuid).max(50).optional(),
    teamId: uuid.optional(),
  }),
  recordCleaningPayment: z.strictObject({
    amount: z.number().int().min(1),
    method: z.enum(['cash', 'mobile_money_offline']),
    reference: text(100, 0).optional(),
  }),
  cancelCleaningMission: requiredReason,
  updateCleaningChecklist: z.strictObject({ doneCodes: z.array(code).max(100) }),
  reportCleaningIncident: z.strictObject({ note: text(2000) }),
  saveCleaningService: serviceDefinition,
  previewCleaningService: z.strictObject({
    definition: serviceDefinition.optional(),
    answers,
    options: z.array(optionSelection).max(20).optional(),
    commune: text(100),
    frequency: code.optional(),
    requestedTeamSize: int(1, 50).optional(),
  }),
  updateCleaningSettings: z.strictObject({
    quoteValidityDays: int(1, 90),
    minimumLeadHours: int(0, 720),
    freeCancellationHours: int(0, 720),
    // Déprécié, ignoré par cleaning (ADR-033).
    visitThresholdSquareMeters: int(1, 100_000).optional(),
    maxOpenRequests: int(1, 100),
    depositPercent: int(0, 100),
    businessWarningUnpaidInvoices: int(1, 24).optional(),
    businessSuspensionUnpaidInvoices: int(1, 24).optional(),
    individualSuspensionUnpaidInterventions: int(1, 50).optional(),
    individualPaymentGraceHours: int(1, 720).optional(),
    // Conservation de la position (ADR-035) : absente, valeur en vigueur gardée.
    locationRetentionMonths: int(1, 120).optional(),
  }),
  saveCleaningZone: z.strictObject({
    commune: text(100),
    // Facultatif (ADR-034) : absent, les noms alternatifs en vigueur sont gardés.
    aliases: z.array(text(100)).max(20).optional(),
  }),
  registerCleaningAgent: z.strictObject({ agentId: uuid, displayName: text(100) }),
  declareCleaningUnavailability: z.strictObject({
    start: dateTime,
    end: dateTime,
    reason: text(200, 0).optional(),
  }),
  createCleaningTeam: team,
  updateCleaningTeam: team,
};

/** Paramètres de chemin et de requête (pagination par curseur, filtres d'état). */
export const cleaningParams = {
  id: uuid,
  serviceCode: code,
  zoneCode: z.string().regex(/^[a-z][a-z0-9_-]{1,99}$/),
  page: z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: uuid.optional(),
  }),
  requestStatus: z
    .enum([
      'received',
      'visit_scheduled',
      'quote_sent',
      'accepted',
      'declined',
      'rejected',
      'expired',
      'cancelled',
    ])
    .optional(),
  missionStatus: z
    .enum(['to_schedule', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'])
    .optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  optionalIdempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .optional(),
  /** Filtre de la liste des demandes : code de zone (commune normalisée), comme ServedZone.code. */
  communeFilter: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,99}$/)
    .optional(),
  customerKind: z.enum(['individual', 'business']).optional(),
  /** Liste des visites (ADR-035). */
  visitStatus: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
  optionalId: uuid.optional(),
  optionalDateTime: dateTime.optional(),
  /** Filtres du parcours par lieu (ADR-034). */
  groupId: uuid.optional(),
  optionalCode: code.optional(),
};

/** Paramètre invalide : 400 GATEWAY_VALIDATION_FAILED, sans reprendre la valeur envoyée. */
export function parseParam<S extends z.ZodType>(schema: S, value: unknown, field: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'La requête est invalide.', {
    fields: [{ field, reason: result.error.issues[0]?.code ?? 'invalid' }],
  });
}
