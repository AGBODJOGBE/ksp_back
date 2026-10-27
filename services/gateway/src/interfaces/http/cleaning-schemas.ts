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
const nullableAmount = z.number().int().min(0).nullable();
const optionalReason = z.strictObject({ reason: text(500, 0).optional() });
const requiredReason = z.strictObject({ reason: text(500) });
const team = z.strictObject({ name: text(100), memberIds: z.array(uuid).max(50) });

export const cleaningBodies = {
  simulateCleaning: z.strictObject({
    serviceCode: code,
    premisesType: z.enum(['apartment', 'house', 'office', 'shop', 'warehouse', 'other']),
    quantity: int(1, 1_000_000),
    options: z.array(code).max(20).optional(),
    commune: text(100),
    frequency: z.enum(['once', 'weekly', 'monthly']).optional(),
  }),
  requestCleaningQuote: z.strictObject({
    serviceCode: code,
    premisesType: z.enum(['apartment', 'house', 'office', 'shop', 'warehouse', 'other']),
    quantity: int(1, 1_000_000),
    options: z.array(code).max(20).optional(),
    commune: text(100),
    address: text(500),
    preferredSlots: z.array(slot).min(1).max(3),
    comment: text(2000, 0).optional(),
    recurrence: recurrence.optional(),
    requestedTeamSize: int(1, 50).optional(),
    daysPerWeek: int(1, 7).optional(),
  }),
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
  declineCleaningQuote: optionalReason,
  cancelCleaningRequest: optionalReason,
  cancelMyCleaningMission: optionalReason,
  rejectCleaningQuoteRequest: requiredReason,
  scheduleCleaningVisit: z.strictObject({ scheduledAt: dateTime, agentId: uuid }),
  completeCleaningVisit: z.strictObject({ report: text(5000) }),
  sendCleaningQuote: z.strictObject({
    lines: z
      .array(z.strictObject({ label: text(200), quantity: int(1, 1_000_000), unitPrice: z.number().int() }))
      .max(50)
      .optional(),
    proposedSlots: z.array(slot).min(1).max(3),
    validityDays: int(1, 90).optional(),
    recurrence: recurrence.optional(),
    teamSize: int(1, 50).optional(),
    durationMinutes: int(1, 1440),
  }),
  scheduleCleaningIntervention: z.strictObject({
    scheduledStart: dateTime,
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
  saveCleaningService: z.strictObject({
    name: text(100),
    description: text(1000, 0).optional(),
    unit: z.enum(['square_meter', 'room', 'septic_tank', 'cubic_meter']),
    active: z.boolean(),
    pricing: z.strictObject({
      unitPrice: nullableAmount,
      minimumPrice: nullableAmount,
      options: z.array(z.strictObject({ code, label: text(100), price: nullableAmount })).optional(),
      communeCoefficients: z
        .array(z.strictObject({ commune: text(100), coefficientBp: int(1, 100_000) }))
        .optional(),
      defaultCoefficientBp: int(1, 100_000).optional(),
      teamSize: z
        .strictObject({ unitsPerAgent: int(1, 1_000_000), minAgents: int(1, 50), maxAgents: int(1, 50) })
        .optional(),
      checklist: z.array(z.strictObject({ code, label: text(200) })).optional(),
    }),
  }),
  updateCleaningSettings: z.strictObject({
    quoteValidityDays: int(1, 90),
    minimumLeadHours: int(0, 720),
    freeCancellationHours: int(0, 720),
    visitThresholdSquareMeters: int(1, 100_000),
    maxOpenRequests: int(1, 100),
    depositPercent: int(0, 100),
    businessWarningUnpaidInvoices: int(1, 24).optional(),
    businessSuspensionUnpaidInvoices: int(1, 24).optional(),
    individualSuspensionUnpaidInterventions: int(1, 50).optional(),
    individualPaymentGraceHours: int(1, 720).optional(),
  }),
  saveCleaningZone: z.strictObject({ commune: text(100) }),
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
};

/** Paramètre invalide : 400 GATEWAY_VALIDATION_FAILED, sans reprendre la valeur envoyée. */
export function parseParam<S extends z.ZodType>(schema: S, value: unknown, field: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'La requête est invalide.', {
    fields: [{ field, reason: result.error.issues[0]?.code ?? 'invalid' }],
  });
}
