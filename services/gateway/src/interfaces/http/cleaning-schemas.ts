// Produit par tools/gateway/cleaning-routes.ts (pnpm gateway:routes) : ne pas modifier, régénérer.
// Source : contracts/openapi/ksp-api.v1.yaml.

import { z } from 'zod';
import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';
import {
  booleanParam,
  date,
  dateTime,
  dependentRequired,
  numberParam,
  unique,
  uuid,
} from './contract-schemas';
import { type CleaningRequestSchema } from './cleaning-request';

const CleaningValues = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  z.union([z.number().int().min(0).max(1000000), z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u), z.boolean()]),
);
const CleaningMonthWeekday = z.strictObject({
  rank: z.enum(['first', 'second', 'third', 'fourth', 'last']),
  weekday: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
});
const CleaningSchedulePlan = z.strictObject({
  kind: z.enum(['one_off', 'weekly', 'monthly']),
  startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u),
  dates: unique(z.array(date).max(400)).optional(),
  weekdays: unique(z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).max(7)).optional(),
  everyWeeks: z.number().int().min(1).max(12).optional(),
  monthDays: unique(z.array(z.number().int().min(1).max(31)).max(31)).optional(),
  monthWeekdays: unique(z.array(CleaningMonthWeekday).max(10)).optional(),
  startDate: date.optional(),
  endDate: date.optional(),
  durationWeeks: z.number().int().min(1).max(260).optional(),
  durationMonths: z.number().int().min(1).max(60).optional(),
  excludedDates: unique(z.array(date).max(400)).optional(),
  addedDates: unique(z.array(date).max(400)).optional(),
  excludeHolidays: z.boolean().optional(),
});
const CleaningSimulateBody = z.strictObject({
  placeTypeId: uuid,
  cleaningTypeIds: unique(z.array(uuid).min(1).max(20)),
  values: CleaningValues,
  schedule: CleaningSchedulePlan.optional(),
  communeKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,99}$/u)
    .optional(),
});
const CleaningPreviewScheduleBody = z.strictObject({ schedule: CleaningSchedulePlan });
const CleaningCreatePlaceBody = z.strictObject({
  name: z.string().min(1).max(100),
  placeTypeId: uuid,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  landmark: z.string().min(1).max(300).regex(/\S/u),
  address: z.string().max(300).optional(),
  declaredValues: CleaningValues.optional(),
  accuracyMeters: z.number().int().min(0).max(100000).optional(),
});
const CleaningUpdatePlaceBody = z
  .strictObject({
    name: z.string().min(1).max(100).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    landmark: z.string().min(1).max(300).regex(/\S/u).optional(),
    address: z.string().max(300).optional(),
    declaredValues: CleaningValues.optional(),
    accuracyMeters: z.number().int().min(0).max(100000).optional(),
  })
  .superRefine(dependentRequired({ latitude: ['longitude'], longitude: ['latitude'] }));
const CleaningLocatePointBody = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const TimeSlot = z.strictObject({ start: dateTime, end: dateTime });
const CleaningSubmitRequestBody = z.strictObject({
  placeId: uuid,
  cleaningTypeIds: unique(z.array(uuid).max(20)),
  values: CleaningValues,
  freeDescription: z.string().min(1).max(2000).optional(),
  schedule: CleaningSchedulePlan,
  visitSlots: z.array(TimeSlot).min(1).max(3),
  comment: z.string().max(1000).optional(),
  photoFileIds: z.array(uuid).max(5).optional(),
});
const CleaningPayVisitFeeBody = z.strictObject({ method: z.enum(['wallet', 'mobile_money']) });
const CleaningChangeVisitSlotBody = z.strictObject({ visitSlots: z.array(TimeSlot).min(1).max(3) });
const CleaningCancelRequestBody = z.strictObject({
  reasonCode: z.enum(['no_longer_needed', 'found_other_provider', 'visit_fee', 'other']).optional(),
  comment: z.string().min(1).max(500).optional(),
});
const CleaningAcceptQuoteBody = z.strictObject({
  acceptTerms: z.boolean(),
  termsVersion: z.string().max(50),
  startDate: date.optional(),
});
const CleaningDeclineQuoteBody = z.strictObject({
  reasonCode: z.enum(['price', 'schedule', 'no_longer_needed', 'other']).optional(),
  comment: z.string().max(1000).optional(),
});
const CleaningRescheduleSessionBody = z.strictObject({ newStart: dateTime });
const CleaningPaySessionBody = z.strictObject({ method: z.enum(['wallet', 'mobile_money']) });
const CleaningRateSessionBody = z.strictObject({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});
const CleaningOpenClaimBody = z.strictObject({
  category: z.enum(['incomplete_work', 'damage', 'behavior', 'missing_item', 'other']),
  text: z.string().min(1).max(2000),
  photoFileIds: z.array(uuid).max(10).optional(),
});
const CleaningAddClaimMessageBody = z.strictObject({ text: z.string().min(1).max(2000) });
const CleaningRenewProgramBody = z.strictObject({ startDate: date.optional() });
const CleaningReorderProgramBody = z.strictObject({ schedule: CleaningSchedulePlan });
const CleaningTimeRange = z.strictObject({
  start: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u),
  end: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u),
});
const CleaningAvailabilityRule = z.strictObject({
  weekday: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  ranges: z.array(CleaningTimeRange).max(6),
});
const PhoneE164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/u);
const CleaningEmergencyContact = z.strictObject({ name: z.string().max(100), phone: PhoneE164 });
const CleaningSubmitAgentApplicationBody = z.strictObject({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  photoFileId: uuid,
  idDocumentFrontFileId: uuid,
  idDocumentBackFileId: uuid,
  residenceCommuneKey: z.string().regex(/^[a-z][a-z0-9-]{1,99}$/u),
  zoneKeys: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{1,99}$/u))
    .min(1)
    .max(77),
  skillCodes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u))
    .min(1)
    .max(20),
  weekly: z.array(CleaningAvailabilityRule).min(1).max(7),
  emergencyContact: CleaningEmergencyContact,
  employmentKind: z.enum(['employee', 'independent']),
  mobileMoneyNumber: PhoneE164.optional(),
  invitationId: uuid.optional(),
});
const CleaningSetMyAvailabilityBody = z.strictObject({
  weekly: z.array(CleaningAvailabilityRule).max(7),
  extraAvailabilities: z.array(TimeSlot).max(50),
});
const CleaningDeclareMyUnavailabilityBody = z.strictObject({
  start: dateTime,
  end: dateTime,
  kind: z.enum(['leave', 'sickness', 'other']),
  note: z.string().max(300).optional(),
});
const CleaningArriveAtVisitBody = z
  .strictObject({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyMeters: z.number().int().min(0).max(100000).optional(),
    occurredAt: dateTime.optional(),
  })
  .superRefine(dependentRequired({ latitude: ['longitude'], longitude: ['latitude'] }));
const CleaningSaveVisitObservationsBody = z.strictObject({
  values: CleaningValues,
  note: z.string().max(1000).optional(),
  occurredAt: dateTime.optional(),
});
const CleaningAddVisitPhotoBody = z.strictObject({ fileId: uuid, occurredAt: dateTime.optional() });
const CleaningCompleteVisitBody = z.strictObject({ occurredAt: dateTime.optional() });
const CleaningReportVisitMissedBody = z.strictObject({ photoFileId: uuid, occurredAt: dateTime.optional() });
const CleaningArriveAtSessionBody = z
  .strictObject({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyMeters: z.number().int().min(0).max(100000).optional(),
    occurredAt: dateTime.optional(),
  })
  .superRefine(dependentRequired({ latitude: ['longitude'], longitude: ['latitude'] }));
const CleaningStartSessionBody = z.strictObject({ occurredAt: dateTime.optional() });
const CleaningChecklistTick = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  checked: z.boolean(),
  cleaningTypeCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .optional(),
});
const CleaningUpdateSessionChecklistBody = z.strictObject({
  items: z.array(CleaningChecklistTick).min(1).max(200),
  occurredAt: dateTime.optional(),
});
const CleaningAddSessionPhotoBody = z.strictObject({
  fileId: uuid,
  kind: z.enum(['before', 'after']),
  occurredAt: dateTime.optional(),
});
const CleaningReportSessionIncidentBody = z.strictObject({
  category: z.enum(['equipment', 'access', 'safety', 'out_of_scope_request', 'other']),
  note: z.string().min(1).max(2000),
  photoFileIds: z.array(uuid).max(10).optional(),
  occurredAt: dateTime.optional(),
});
const CleaningCompleteSessionBody = z.strictObject({
  signatureFileId: uuid.optional(),
  occurredAt: dateTime.optional(),
});
const CleaningReportSessionMissedBody = z.strictObject({
  cause: z.enum(['customer_absent', 'access_impossible']),
  photoFileId: uuid,
  waitStartedAt: dateTime,
  calledAt: dateTime,
  occurredAt: dateTime.optional(),
});
const CleaningAmountInput = z.strictObject({
  amount: z.number().int().min(0).max(100000000),
  currency: z.literal('XOF'),
});
const CleaningCreatePlaceCategoryBody = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  name: z.string().min(1).max(100),
  icon: z.string().max(50).optional(),
  order: z.number().int().min(0).optional(),
  visitFee: CleaningAmountInput.optional(),
});
const CleaningUpdatePlaceCategoryBody = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  icon: z.string().max(50).optional(),
  order: z.number().int().min(0).optional(),
  visitFee: CleaningAmountInput.optional(),
  active: z.boolean().optional(),
});
const CleaningCreatePlaceTypeBody = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  categoryId: uuid,
  name: z.string().min(1).max(100),
  icon: z.string().max(50).optional(),
  photoFileId: uuid.optional(),
  description: z.string().max(1000).optional(),
  order: z.number().int().min(0).optional(),
  freeDescription: z.boolean().optional(),
  parameterIds: z.array(uuid).max(30),
  areaParameterId: uuid.optional(),
  active: z.boolean().optional(),
});
const CleaningUpdatePlaceTypeBody = z.strictObject({
  categoryId: uuid.optional(),
  name: z.string().min(1).max(100).optional(),
  icon: z.string().max(50).optional(),
  photoFileId: uuid.optional(),
  description: z.string().max(1000).optional(),
  order: z.number().int().min(0).optional(),
  freeDescription: z.boolean().optional(),
  parameterIds: z.array(uuid).max(30).optional(),
  areaParameterId: uuid.optional(),
  active: z.boolean().optional(),
});
const CleaningChecklistTemplateItem = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  label: z.string().min(1).max(200),
  order: z.number().int().min(0),
});
const CleaningCreateCleaningTypeBody = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  icon: z.string().max(50).optional(),
  requiredSkillCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .optional(),
  referenceDurationMinutes: z.number().int().min(1).max(1440),
  checklist: z.array(CleaningChecklistTemplateItem).max(50),
  isPack: z.boolean().optional(),
  packItemIds: z.array(uuid).max(20).optional(),
});
const CleaningUpdateCleaningTypeBody = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(50).optional(),
  requiredSkillCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .optional(),
  referenceDurationMinutes: z.number().int().min(1).max(1440).optional(),
  checklist: z.array(CleaningChecklistTemplateItem).max(50).optional(),
  isPack: z.boolean().optional(),
  packItemIds: z.array(uuid).max(20).optional(),
  active: z.boolean().optional(),
});
const CleaningParameterChoice = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  label: z.string().min(1).max(100),
  active: z.boolean(),
});
const CleaningCreateParameterBody = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  label: z.string().min(1).max(100),
  kind: z.enum(['number', 'choice', 'boolean']),
  unit: z.string().max(20).optional(),
  min: z.number().int().min(0).max(1000000).optional(),
  max: z.number().int().min(0).max(1000000).optional(),
  choices: z.array(CleaningParameterChoice).max(30).optional(),
  required: z.boolean(),
  help: z.string().max(300).optional(),
});
const CleaningUpdateParameterBody = z.strictObject({
  label: z.string().min(1).max(100).optional(),
  unit: z.string().max(20).optional(),
  min: z.number().int().min(0).max(1000000).optional(),
  max: z.number().int().min(0).max(1000000).optional(),
  choices: z.array(CleaningParameterChoice).max(30).optional(),
  required: z.boolean().optional(),
  help: z.string().max(300).optional(),
  active: z.boolean().optional(),
});
const CleaningTeamRuleBracket = z.strictObject({
  fromArea: z.number().int().min(0),
  toArea: z.number().int().min(0).nullable(),
  agents: z.number().int().min(1).max(50),
  durationMinutes: z.number().int().min(15).max(1440),
});
const CleaningCreateOfferBody = z.strictObject({
  placeTypeId: uuid,
  cleaningTypeId: uuid,
  extraParameterIds: z.array(uuid).max(20),
  teamRule: z.array(CleaningTeamRuleBracket).min(0).max(20),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});
const CleaningUpdateOfferBody = z.strictObject({
  extraParameterIds: z.array(uuid).max(20).optional(),
  teamRule: z.array(CleaningTeamRuleBracket).max(20).optional(),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});
const CleaningTariffBracketInput = z.strictObject({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  mode: z.enum(['flat', 'per_unit']),
  amount: CleaningAmountInput,
});
const CleaningTariffSupplementInput = z.strictObject({
  parameterCode: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  choiceCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .optional(),
  mode: z.enum(['fixed', 'per_unit', 'coefficient']),
  amount: CleaningAmountInput.optional(),
  coefficientBps: z.number().int().min(1).max(100000).optional(),
  includedUnits: z.number().int().min(0).max(1000000).optional(),
});
const CleaningFrequencyCoefficient = z.strictObject({
  key: z.string().regex(/^(weekly|monthly|every_([2-9]|1[0-2])_weeks)$/u),
  coefficientBps: z.number().int().min(1).max(100000),
});
const CleaningCreateTariffDraftBody = z.strictObject({
  baseParameterCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .optional(),
  brackets: z.array(CleaningTariffBracketInput).min(0).max(30),
  supplements: z.array(CleaningTariffSupplementInput).max(50),
  minimum: CleaningAmountInput,
  frequencyCoefficients: z.array(CleaningFrequencyCoefficient).max(20),
  packDiscountBps: z.number().int().min(0).max(9000).optional(),
});
const CleaningUpdateTariffDraftBody = z.strictObject({
  baseParameterCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .optional(),
  brackets: z.array(CleaningTariffBracketInput).min(0).max(30),
  supplements: z.array(CleaningTariffSupplementInput).max(50),
  minimum: CleaningAmountInput,
  frequencyCoefficients: z.array(CleaningFrequencyCoefficient).max(20),
  packDiscountBps: z.number().int().min(0).max(9000).optional(),
});
const CleaningSimulateWithDraftsBody = z.strictObject({
  placeTypeId: uuid,
  cleaningTypeIds: unique(z.array(uuid).min(1).max(20)),
  values: CleaningValues,
  schedule: CleaningSchedulePlan.optional(),
  communeKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,99}$/u)
    .optional(),
  draftTariffIds: z.array(uuid).max(20),
});
const CleaningCreateSkillBody = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u),
  name: z.string().min(1).max(100),
});
const CleaningUpdateSkillBody = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
});
const CleaningCreateHolidayBody = z.strictObject({ date: date, name: z.string().min(1).max(100) });
const CleaningCreateZoneBody = z.strictObject({
  communeKey: z.string().regex(/^[a-z][a-z0-9-]{1,99}$/u),
  name: z.string().min(1).max(100).optional(),
  coefficientBps: z.number().int().min(1).max(100000).optional(),
  visitFeeSurcharge: CleaningAmountInput.optional(),
  planningMode: z.enum(['manual', 'proposal', 'automatic']).optional(),
});
const CleaningUpdateZoneBody = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  coefficientBps: z.number().int().min(1).max(100000).optional(),
  visitFeeSurcharge: CleaningAmountInput.optional(),
  planningMode: z.enum(['manual', 'proposal', 'automatic']).optional(),
});
const CleaningSetZoneActiveBody = z.strictObject({ active: z.boolean(), confirm: z.boolean().optional() });
const CleaningRejectRequestBody = z.strictObject({
  reasonCode: z.enum(['place_inaccessible', 'service_impossible', 'other']),
  reason: z.string().min(1).max(500),
});
const CleaningCorrectRequestLocationBody = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().int().min(0).max(100000).optional(),
  landmark: z.string().min(1).max(300).regex(/\S/u).optional(),
  address: z.string().max(300).optional(),
  reason: z.string().min(1).max(500),
});
const CleaningDecideReactivationBody = z.strictObject({
  decision: z.enum(['accept', 'refuse']),
  reason: z.string().max(500).optional(),
});
const CleaningCheckOverride = z.strictObject({
  check: z.enum(['zone', 'availability', 'load', 'team_size']),
  reason: z.string().min(1).max(500),
});
const CleaningScheduleVisitBody = z.strictObject({
  requestId: uuid,
  scheduledAt: dateTime,
  durationMinutes: z.number().int().min(15).max(480).optional(),
  agentIds: z.array(uuid).max(10),
  leadAgentId: uuid.optional(),
  autoAssign: z.boolean().optional(),
  overrides: z.array(CleaningCheckOverride).max(4).optional(),
});
const CleaningUpdateVisitBody = z.strictObject({
  scheduledAt: dateTime.optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  agentIds: z.array(uuid).max(10).optional(),
  leadAgentId: uuid.optional(),
  overrides: z.array(CleaningCheckOverride).max(4).optional(),
  reason: z.string().max(500).optional(),
});
const CleaningCancelVisitBody = z.strictObject({
  cause: z.enum(['ksp', 'agent_no_show']),
  reason: z.string().min(1).max(500),
});
const CleaningRequestNewVisitBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningCompleteVisitOnBehalfBody = z.strictObject({
  reason: z.string().min(1).max(500),
  arrivedAt: dateTime.optional(),
  completedAt: dateTime,
  values: CleaningValues.optional(),
  photoFileIds: z.array(uuid).max(10).optional(),
});
const CleaningReportVisitMissedOnBehalfBody = z.strictObject({
  reason: z.string().min(1).max(500),
  missedAt: dateTime,
  photoFileId: uuid.optional(),
});
const CleaningRemoveVisitPhotoAsKspBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningValueReason = z.strictObject({
  parameterCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,49}$/u)
    .nullable(),
  cleaningTypeId: uuid.nullable(),
  reason: z.string().min(1).max(500),
});
const CleaningSaveRetainedValuesBody = z.strictObject({
  values: CleaningValues,
  cleaningTypeIds: unique(z.array(uuid).max(20)),
  reasons: z.array(CleaningValueReason).max(60),
  reason: z.string().min(1).max(500).optional(),
});
const CleaningEstimateRetainedValuesBody = z.strictObject({
  values: CleaningValues,
  cleaningTypeIds: unique(z.array(uuid).max(20)),
});
const CleaningAdjustmentInput = z.strictObject({
  kind: z.enum(['discount', 'surcharge']),
  percentBps: z.number().int().min(1).max(10000).optional(),
  fixedAmount: CleaningAmountInput.optional(),
  reason: z.string().min(1).max(500),
});
const CleaningOnQuotePrice = z.strictObject({ offerId: uuid, price: CleaningAmountInput });
const CleaningCreateQuoteBody = z.strictObject({
  schedule: CleaningSchedulePlan.optional(),
  teamSize: z.number().int().min(1).max(50).optional(),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
  adjustments: z.array(CleaningAdjustmentInput).max(5).optional(),
  onQuotePrices: z.array(CleaningOnQuotePrice).max(20).optional(),
  validityDays: z.number().int().min(1).max(90).optional(),
});
const CleaningUpdateQuoteDraftBody = z.strictObject({
  schedule: CleaningSchedulePlan.optional(),
  teamSize: z.number().int().min(1).max(50).optional(),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
  adjustments: z.array(CleaningAdjustmentInput).max(5).optional(),
  onQuotePrices: z.array(CleaningOnQuotePrice).max(20).optional(),
  validityDays: z.number().int().min(1).max(90).optional(),
});
const CleaningCreateAgentBody = z.strictObject({
  phone: PhoneE164,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  photoFileId: uuid,
  idDocumentFrontFileId: uuid,
  idDocumentBackFileId: uuid,
  residenceCommuneKey: z.string().regex(/^[a-z][a-z0-9-]{1,99}$/u),
  zoneKeys: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{1,99}$/u))
    .min(1)
    .max(77),
  skillCodes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u))
    .min(1)
    .max(20),
  weekly: z.array(CleaningAvailabilityRule).min(1).max(7),
  emergencyContact: CleaningEmergencyContact,
  employmentKind: z.enum(['employee', 'independent']),
  mobileMoneyNumber: PhoneE164.optional(),
});
const CleaningUpdateAgentBody = z.strictObject({
  zoneKeys: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{1,99}$/u))
    .max(77)
    .optional(),
  validatedSkillCodes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u))
    .max(20)
    .optional(),
  maxHoursPerDay: z.number().int().min(1).max(24).optional(),
  maxHoursPerWeek: z.number().int().min(1).max(168).optional(),
  employmentKind: z.enum(['employee', 'independent']).optional(),
  residenceCommuneKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,99}$/u)
    .optional(),
  emergencyContact: CleaningEmergencyContact.optional(),
});
const CleaningInviteAgentBody = z.strictObject({ phone: PhoneE164 });
const CleaningApproveAgentBody = z.strictObject({
  validatedSkillCodes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,49}$/u))
    .min(1)
    .max(20),
});
const CleaningRejectAgentBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningSuspendAgentBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningDeactivateAgentBody = z.strictObject({
  reassign: z.boolean(),
  reason: z.string().min(1).max(500),
});
const CleaningSetAgentAvailabilityBody = z.strictObject({
  weekly: z.array(CleaningAvailabilityRule).max(7),
  extraAvailabilities: z.array(TimeSlot).max(50),
  maxHoursPerDay: z.number().int().min(1).max(24).optional(),
  maxHoursPerWeek: z.number().int().min(1).max(168).optional(),
  force: z.boolean().optional(),
});
const CleaningDeclareAgentUnavailabilityBody = z.strictObject({
  start: dateTime,
  end: dateTime,
  kind: z.enum(['leave', 'sickness', 'other']),
  note: z.string().max(300).optional(),
  force: z.boolean().optional(),
});
const CleaningCreateTeamBody = z.strictObject({
  name: z.string().min(1).max(100),
  leadAgentId: uuid,
  memberIds: z.array(uuid).min(1).max(30),
});
const CleaningUpdateTeamBody = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  leadAgentId: uuid.optional(),
  memberIds: z.array(uuid).max(30).optional(),
  active: z.boolean().optional(),
});
const CleaningAssignmentTarget = z.strictObject({ kind: z.enum(['visit', 'session']), id: uuid });
const CleaningCheckAssignmentBody = z.strictObject({
  targets: z.array(CleaningAssignmentTarget).min(1).max(400),
  agentIds: z.array(uuid).max(30).optional(),
  teamId: uuid.optional(),
  leadAgentId: uuid.optional(),
  overrides: z.array(CleaningCheckOverride).max(4).optional(),
});
const CleaningCreateAssignmentsBody = z.strictObject({
  targets: z.array(CleaningAssignmentTarget).min(1).max(400),
  agentIds: z.array(uuid).max(30).optional(),
  teamId: uuid.optional(),
  leadAgentId: uuid.optional(),
  overrides: z.array(CleaningCheckOverride).max(4).optional(),
  skipFailing: z.boolean().optional(),
});
const CleaningUpdateAssignmentBody = z.strictObject({
  replaceWithAgentId: uuid.optional(),
  isLead: z.boolean().optional(),
  overrides: z.array(CleaningCheckOverride).max(4).optional(),
  reason: z.string().min(1).max(500),
});
const CleaningRemoveAssignmentBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningRunAutoPlanningBody = z.strictObject({
  from: dateTime.optional(),
  to: dateTime.optional(),
  zoneKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,99}$/u)
    .optional(),
  programId: uuid.optional(),
});
const CleaningApproveProposalsBody = z.strictObject({ assignmentIds: z.array(uuid).min(1).max(400) });
const CleaningChangeProgramScheduleBody = z.strictObject({
  effectiveFrom: date,
  schedule: CleaningSchedulePlan,
  reason: z.string().min(1).max(500),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
});
const CleaningCreateAmendmentBody = z.strictObject({
  addCleaningTypeIds: z.array(uuid).max(20).optional(),
  addSchedule: CleaningSchedulePlan.optional(),
  values: CleaningValues.optional(),
  teamSize: z.number().int().min(1).max(50).optional(),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
  adjustments: z.array(CleaningAdjustmentInput).max(5).optional(),
  onQuotePrices: z.array(CleaningOnQuotePrice).max(20).optional(),
  validityDays: z.number().int().min(1).max(90).optional(),
});
const CleaningSuspendProgramBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningResumeProgramBody = z.strictObject({ reason: z.string().max(500).optional() });
const CleaningCancelProgramBody = z.strictObject({ reason: z.string().min(1).max(500) });
const CleaningRescheduleSessionAsKspBody = z.strictObject({
  newStart: dateTime,
  reason: z.string().min(1).max(500),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
});
const CleaningCancelSessionAsKspBody = z.strictObject({
  initiatedBy: z.enum(['ksp', 'customer_late']),
  reason: z.string().min(1).max(500),
});
const CleaningResumeSessionBody = z.strictObject({ reason: z.string().max(500).optional() });
const CleaningCompleteSessionAsKspBody = z.strictObject({
  reason: z.string().min(1).max(500),
  startedAt: dateTime,
  completedAt: dateTime,
  presentAgentIds: z.array(uuid).min(1).max(30),
  beforePhotoFileIds: z.array(uuid).max(10).optional(),
  afterPhotoFileIds: z.array(uuid).max(10).optional(),
});
const CleaningReportSessionMissedAsKspBody = z.strictObject({
  reason: z.string().min(1).max(500),
  cause: z.enum(['customer_absent', 'access_impossible']),
  missedAt: dateTime,
  presentAgentIds: z.array(uuid).min(1).max(30),
  photoFileId: uuid.optional(),
  waitStartedAt: dateTime.optional(),
  calledAt: dateTime.optional(),
});
const CleaningRemoveSessionPhotoAsKspBody = z.strictObject({
  reason: z.string().min(1).max(500),
  replacementFileId: uuid.optional(),
});
const CleaningUpdateClaimBody = z.strictObject({
  status: z.enum(['in_progress']).optional(),
  message: z.string().max(2000).optional(),
});
const CleaningDecideClaimBody = z.strictObject({
  outcome: z.enum(['free_redo', 'wallet_credit', 'rejected']),
  creditAmount: CleaningAmountInput.optional(),
  reason: z.string().min(1).max(500),
});
const CleaningScoreWeights = z.strictObject({
  continuity: z.number().int().min(0).max(100),
  proximity: z.number().int().min(0).max(100),
  balance: z.number().int().min(0).max(100),
  rating: z.number().int().min(0).max(100),
});
const CleaningUpdateSettingsBody = z.strictObject({
  maxOpenRequestsPerAccount: z.number().int().min(1).max(100).optional(),
  minVisitLeadHours: z.number().int().min(0).max(168).optional(),
  visitFeePaymentHours: z.number().int().min(1).max(168).optional(),
  visitTargetBusinessHours: z.number().int().min(24).max(240).optional(),
  visitDurationMinutes: z.number().int().min(15).max(480).optional(),
  defaultTravelMinutes: z.number().int().min(0).max(120).optional(),
  defaultVisitFee: CleaningAmountInput.optional(),
  deductVisitFee: z.boolean().optional(),
  quoteValidityDays: z.number().int().min(1).max(90).optional(),
  quoteReminderDays: z.number().int().min(0).max(30).optional(),
  maxDiscountWithoutApprovalPercent: z.number().int().min(0).max(100).optional(),
  firstSessionLeadHours: z.number().int().min(0).max(720).optional(),
  programMaxMonths: z.number().int().min(1).max(60).optional(),
  programMaxSessions: z.number().int().min(1).max(1000).optional(),
  freeCancellationHours: z.number().int().min(0).max(168).optional(),
  reschedulesPerMonth: z.number().int().min(0).max(10).optional(),
  lateCancellationFeePercent: z.number().int().min(0).max(100).optional(),
  sessionPaymentGraceHours: z.number().int().min(1).max(168).optional(),
  overdueSessionsBeforeSuspension: z.number().int().min(1).max(10).optional(),
  balanceGuarantee: z.boolean().optional(),
  unpaidInvoicesWarning: z.number().int().min(1).max(12).optional(),
  unpaidInvoicesSuspension: z.number().int().min(1).max(12).optional(),
  defaultPlanningMode: z.enum(['manual', 'proposal', 'automatic']).optional(),
  planningHorizonDays: z.number().int().min(1).max(60).optional(),
  scoreWeights: CleaningScoreWeights.optional(),
  assignmentResponseHours: z.number().int().min(1).max(72).optional(),
  defaultMaxHoursPerDay: z.number().int().min(1).max(24).optional(),
  defaultMaxHoursPerWeek: z.number().int().min(1).max(168).optional(),
  maxPhotosPerKind: z.number().int().min(1).max(50).optional(),
  claimWindowHours: z.number().int().min(12).max(168).optional(),
  retentionMonths: z.number().int().min(1).max(120).optional(),
  commonChecklist: z.array(CleaningChecklistTemplateItem).max(50).optional(),
  arrivalAlertMeters: z.number().int().min(50).max(5000).optional(),
  arrivalMaxAdvanceMinutes: z.number().int().min(0).max(240).optional(),
  customerWaitMinutes: z.number().int().min(10).max(120).optional(),
});

/** Paramètres de chemin, de requête et corps de chaque route (champs inconnus du corps refusés). */
export const CLEANING_REQUESTS = {
  cleaningListCatalog: {},
  cleaningGetCatalogPlaceType: { params: z.object({ id: uuid }) },
  cleaningListServedZones: {},
  cleaningSimulate: { body: CleaningSimulateBody, bodyRequired: true },
  cleaningPreviewSchedule: { body: CleaningPreviewScheduleBody, bodyRequired: true },
  cleaningListMyPlaces: {
    query: z.object({
      archived: booleanParam.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-createdAt', 'name']).optional(),
    }),
  },
  cleaningCreatePlace: { body: CleaningCreatePlaceBody, bodyRequired: true },
  cleaningGetMyPlace: { params: z.object({ id: uuid }) },
  cleaningUpdatePlace: { params: z.object({ id: uuid }), body: CleaningUpdatePlaceBody },
  cleaningArchivePlace: { params: z.object({ id: uuid }) },
  cleaningLocatePoint: { body: CleaningLocatePointBody, bodyRequired: true },
  cleaningListMyRequests: {
    query: z.object({
      status: z
        .enum([
          'awaiting_visit_fee',
          'visit_to_schedule',
          'visit_scheduled',
          'visit_missed',
          'visit_done',
          'quote_sent',
          'accepted',
          'declined',
          'expired',
          'cancelled',
          'rejected',
        ])
        .optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-createdAt', '-updatedAt']).optional(),
    }),
  },
  cleaningSubmitRequest: { body: CleaningSubmitRequestBody, bodyRequired: true },
  cleaningGetMyRequest: { params: z.object({ id: uuid }) },
  cleaningPayVisitFee: { params: z.object({ id: uuid }), body: CleaningPayVisitFeeBody, bodyRequired: true },
  cleaningChangeVisitSlot: {
    params: z.object({ id: uuid }),
    body: CleaningChangeVisitSlotBody,
    bodyRequired: true,
  },
  cleaningCancelRequest: { params: z.object({ id: uuid }), body: CleaningCancelRequestBody },
  cleaningRequestReactivation: { params: z.object({ id: uuid }) },
  cleaningGetMyQuote: { params: z.object({ id: uuid }) },
  cleaningAcceptQuote: { params: z.object({ id: uuid }), body: CleaningAcceptQuoteBody, bodyRequired: true },
  cleaningDeclineQuote: { params: z.object({ id: uuid }), body: CleaningDeclineQuoteBody },
  cleaningForwardQuote: { params: z.object({ id: uuid }) },
  cleaningListMyPrograms: {
    query: z.object({
      status: z.enum(['confirmed', 'in_progress', 'suspended', 'completed', 'cancelled']).optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-createdAt', 'nextSession']).optional(),
    }),
  },
  cleaningGetMyProgram: { params: z.object({ id: uuid }) },
  cleaningListMyProgramSessions: {
    params: z.object({ id: uuid }),
    query: z.object({
      status: z
        .enum([
          'to_assign',
          'assigned',
          'in_progress',
          'interrupted',
          'completed',
          'missed',
          'suspended',
          'cancelled',
        ])
        .optional(),
      from: dateTime.optional(),
      to: dateTime.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['scheduledStart', '-scheduledStart']).optional(),
    }),
  },
  cleaningGetMySession: { params: z.object({ id: uuid }) },
  cleaningRescheduleSession: {
    params: z.object({ id: uuid }),
    body: CleaningRescheduleSessionBody,
    bodyRequired: true,
  },
  cleaningCancelSession: { params: z.object({ id: uuid }) },
  cleaningStopProgram: { params: z.object({ id: uuid }) },
  cleaningPaySession: { params: z.object({ id: uuid }), body: CleaningPaySessionBody, bodyRequired: true },
  cleaningRateSession: { params: z.object({ id: uuid }), body: CleaningRateSessionBody, bodyRequired: true },
  cleaningOpenClaim: { params: z.object({ id: uuid }), body: CleaningOpenClaimBody, bodyRequired: true },
  cleaningListMyClaims: {
    query: z.object({
      status: z.enum(['open', 'in_progress', 'resolved', 'rejected']).optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-openedAt']).optional(),
    }),
  },
  cleaningGetMyClaim: { params: z.object({ id: uuid }) },
  cleaningAddClaimMessage: {
    params: z.object({ id: uuid }),
    body: CleaningAddClaimMessageBody,
    bodyRequired: true,
  },
  cleaningRenewProgram: { params: z.object({ id: uuid }), body: CleaningRenewProgramBody },
  cleaningReorderProgram: {
    params: z.object({ id: uuid }),
    body: CleaningReorderProgramBody,
    bodyRequired: true,
  },
  cleaningSubmitAgentApplication: { body: CleaningSubmitAgentApplicationBody, bodyRequired: true },
  cleaningGetMyAgentProfile: {},
  cleaningGetMyActivity: {},
  cleaningGetMyAvailability: {},
  cleaningSetMyAvailability: { body: CleaningSetMyAvailabilityBody, bodyRequired: true },
  cleaningDeclareMyUnavailability: { body: CleaningDeclareMyUnavailabilityBody, bodyRequired: true },
  cleaningRemoveMyUnavailability: { params: z.object({ id: uuid }) },
  cleaningListMyAssignments: {
    query: z.object({
      from: dateTime.optional(),
      to: dateTime.optional(),
      status: z
        .enum(['proposed', 'pending_confirmation', 'confirmed', 'declined', 'expired', 'removed'])
        .optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['start']).optional(),
    }),
  },
  cleaningAcceptAssignment: { params: z.object({ id: uuid }) },
  cleaningDeclineAssignment: { params: z.object({ id: uuid }) },
  cleaningGetAgentVisit: { params: z.object({ id: uuid }) },
  cleaningArriveAtVisit: { params: z.object({ id: uuid }), body: CleaningArriveAtVisitBody },
  cleaningSaveVisitObservations: {
    params: z.object({ id: uuid }),
    body: CleaningSaveVisitObservationsBody,
    bodyRequired: true,
  },
  cleaningAddVisitPhoto: {
    params: z.object({ id: uuid }),
    body: CleaningAddVisitPhotoBody,
    bodyRequired: true,
  },
  cleaningCompleteVisit: { params: z.object({ id: uuid }), body: CleaningCompleteVisitBody },
  cleaningReportVisitMissed: {
    params: z.object({ id: uuid }),
    body: CleaningReportVisitMissedBody,
    bodyRequired: true,
  },
  cleaningRemoveVisitPhoto: { params: z.object({ id: uuid, fileId: uuid }) },
  cleaningGetAgentSession: { params: z.object({ id: uuid }) },
  cleaningArriveAtSession: { params: z.object({ id: uuid }), body: CleaningArriveAtSessionBody },
  cleaningStartSession: { params: z.object({ id: uuid }), body: CleaningStartSessionBody },
  cleaningUpdateSessionChecklist: {
    params: z.object({ id: uuid }),
    body: CleaningUpdateSessionChecklistBody,
    bodyRequired: true,
  },
  cleaningAddSessionPhoto: {
    params: z.object({ id: uuid }),
    body: CleaningAddSessionPhotoBody,
    bodyRequired: true,
  },
  cleaningReportSessionIncident: {
    params: z.object({ id: uuid }),
    body: CleaningReportSessionIncidentBody,
    bodyRequired: true,
  },
  cleaningCompleteSession: { params: z.object({ id: uuid }), body: CleaningCompleteSessionBody },
  cleaningReportSessionMissed: {
    params: z.object({ id: uuid }),
    body: CleaningReportSessionMissedBody,
    bodyRequired: true,
  },
  cleaningRemoveSessionPhoto: { params: z.object({ id: uuid, fileId: uuid }) },
  cleaningListPlaceCategories: {
    query: z.object({
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['order', 'name']).optional(),
    }),
  },
  cleaningCreatePlaceCategory: { body: CleaningCreatePlaceCategoryBody, bodyRequired: true },
  cleaningGetPlaceCategory: { params: z.object({ id: uuid }) },
  cleaningUpdatePlaceCategory: { params: z.object({ id: uuid }), body: CleaningUpdatePlaceCategoryBody },
  cleaningListPlaceTypes: {
    query: z.object({
      categoryId: uuid.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['order', 'name']).optional(),
    }),
  },
  cleaningCreatePlaceType: { body: CleaningCreatePlaceTypeBody, bodyRequired: true },
  cleaningGetPlaceType: { params: z.object({ id: uuid }) },
  cleaningUpdatePlaceType: { params: z.object({ id: uuid }), body: CleaningUpdatePlaceTypeBody },
  cleaningListCleaningTypes: {
    query: z.object({
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['name']).optional(),
    }),
  },
  cleaningCreateCleaningType: { body: CleaningCreateCleaningTypeBody, bodyRequired: true },
  cleaningGetCleaningType: { params: z.object({ id: uuid }) },
  cleaningUpdateCleaningType: { params: z.object({ id: uuid }), body: CleaningUpdateCleaningTypeBody },
  cleaningListParameters: {
    query: z.object({
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['code']).optional(),
    }),
  },
  cleaningCreateParameter: { body: CleaningCreateParameterBody, bodyRequired: true },
  cleaningGetParameter: { params: z.object({ id: uuid }) },
  cleaningUpdateParameter: { params: z.object({ id: uuid }), body: CleaningUpdateParameterBody },
  cleaningListOffers: {
    query: z.object({
      placeTypeId: uuid.optional(),
      cleaningTypeId: uuid.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['createdAt']).optional(),
    }),
  },
  cleaningCreateOffer: { body: CleaningCreateOfferBody, bodyRequired: true },
  cleaningGetOffer: { params: z.object({ id: uuid }) },
  cleaningUpdateOffer: { params: z.object({ id: uuid }), body: CleaningUpdateOfferBody },
  cleaningListTariffs: {
    params: z.object({ id: uuid }),
    query: z.object({
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-version']).optional(),
    }),
  },
  cleaningCreateTariffDraft: {
    params: z.object({ id: uuid }),
    body: CleaningCreateTariffDraftBody,
    bodyRequired: true,
  },
  cleaningUpdateTariffDraft: {
    params: z.object({ id: uuid, version: numberParam(z.number().int().min(1)) }),
    body: CleaningUpdateTariffDraftBody,
    bodyRequired: true,
  },
  cleaningPublishTariff: { params: z.object({ id: uuid, version: numberParam(z.number().int().min(1)) }) },
  cleaningSimulateWithDrafts: { body: CleaningSimulateWithDraftsBody, bodyRequired: true },
  cleaningListSkills: {
    query: z.object({
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['name']).optional(),
    }),
  },
  cleaningCreateSkill: { body: CleaningCreateSkillBody, bodyRequired: true },
  cleaningUpdateSkill: { params: z.object({ id: uuid }), body: CleaningUpdateSkillBody },
  cleaningListHolidays: {
    query: z.object({
      year: numberParam(z.number().int().min(2020).max(2100)).optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['date']).optional(),
    }),
  },
  cleaningCreateHoliday: { body: CleaningCreateHolidayBody, bodyRequired: true },
  cleaningDeleteHoliday: { params: z.object({ id: uuid }) },
  cleaningListZones: {
    query: z.object({
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['name']).optional(),
    }),
  },
  cleaningCreateZone: { body: CleaningCreateZoneBody, bodyRequired: true },
  cleaningUpdateZone: { params: z.object({ id: uuid }), body: CleaningUpdateZoneBody },
  cleaningSetZoneActive: {
    params: z.object({ id: uuid }),
    body: CleaningSetZoneActiveBody,
    bodyRequired: true,
  },
  cleaningListCommunes: {},
  cleaningListRequests: {
    query: z.object({
      status: z
        .enum([
          'awaiting_visit_fee',
          'visit_to_schedule',
          'visit_scheduled',
          'visit_missed',
          'visit_done',
          'quote_sent',
          'accepted',
          'declined',
          'expired',
          'cancelled',
          'rejected',
        ])
        .optional(),
      communeKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      placeTypeId: uuid.optional(),
      from: dateTime.optional(),
      to: dateTime.optional(),
      q: z.string().max(50).optional(),
      customerKind: z.enum(['individual', 'organization']).optional(),
      cleaningTypeId: uuid.optional(),
      customerId: uuid.optional(),
      organizationId: uuid.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-createdAt', 'createdAt', 'nextVisitAt']).optional(),
    }),
  },
  cleaningGetRequest: { params: z.object({ id: uuid }) },
  cleaningRejectRequest: {
    params: z.object({ id: uuid }),
    body: CleaningRejectRequestBody,
    bodyRequired: true,
  },
  cleaningCorrectRequestLocation: {
    params: z.object({ id: uuid }),
    body: CleaningCorrectRequestLocationBody,
    bodyRequired: true,
  },
  cleaningCorrectRequestLocationOnSite: {
    params: z.object({ id: uuid }),
    body: CleaningCorrectRequestLocationBody,
    bodyRequired: true,
  },
  cleaningDecideReactivation: {
    params: z.object({ id: uuid }),
    body: CleaningDecideReactivationBody,
    bodyRequired: true,
  },
  cleaningListVisits: {
    query: z.object({
      from: dateTime.optional(),
      to: dateTime.optional(),
      status: z.enum(['scheduled', 'in_progress', 'completed', 'missed', 'cancelled']).optional(),
      agentId: uuid.optional(),
      communeKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['scheduledAt', '-scheduledAt']).optional(),
    }),
  },
  cleaningScheduleVisit: { body: CleaningScheduleVisitBody, bodyRequired: true },
  cleaningUpdateVisit: { params: z.object({ id: uuid }), body: CleaningUpdateVisitBody },
  cleaningCancelVisit: { params: z.object({ id: uuid }), body: CleaningCancelVisitBody, bodyRequired: true },
  cleaningRequestNewVisit: {
    params: z.object({ id: uuid }),
    body: CleaningRequestNewVisitBody,
    bodyRequired: true,
  },
  cleaningCompleteVisitOnBehalf: {
    params: z.object({ id: uuid }),
    body: CleaningCompleteVisitOnBehalfBody,
    bodyRequired: true,
  },
  cleaningReportVisitMissedOnBehalf: {
    params: z.object({ id: uuid }),
    body: CleaningReportVisitMissedOnBehalfBody,
    bodyRequired: true,
  },
  cleaningRemoveVisitPhotoAsKsp: {
    params: z.object({ id: uuid, fileId: uuid }),
    body: CleaningRemoveVisitPhotoAsKspBody,
    bodyRequired: true,
  },
  cleaningSaveRetainedValues: {
    params: z.object({ id: uuid }),
    body: CleaningSaveRetainedValuesBody,
    bodyRequired: true,
  },
  cleaningEstimateRetainedValues: {
    params: z.object({ id: uuid }),
    body: CleaningEstimateRetainedValuesBody,
    bodyRequired: true,
  },
  cleaningCreateQuote: { params: z.object({ id: uuid }), body: CleaningCreateQuoteBody },
  cleaningGetQuote: { params: z.object({ id: uuid }) },
  cleaningUpdateQuoteDraft: { params: z.object({ id: uuid }), body: CleaningUpdateQuoteDraftBody },
  cleaningApproveQuoteAdjustment: { params: z.object({ id: uuid }) },
  cleaningSendQuote: { params: z.object({ id: uuid }) },
  cleaningListAgents: {
    query: z.object({
      status: z
        .enum(['applicant', 'under_review', 'active', 'suspended', 'deactivated', 'rejected'])
        .optional(),
      zoneKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      skillCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]{1,49}$/u)
        .optional(),
      q: z.string().max(100).optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['lastName', '-createdAt', '-ratingAverage']).optional(),
    }),
  },
  cleaningCreateAgent: { body: CleaningCreateAgentBody, bodyRequired: true },
  cleaningGetAgent: { params: z.object({ id: uuid }) },
  cleaningUpdateAgent: { params: z.object({ id: uuid }), body: CleaningUpdateAgentBody },
  cleaningGetAgentIdDocument: { params: z.object({ id: uuid }) },
  cleaningInviteAgent: { body: CleaningInviteAgentBody, bodyRequired: true },
  cleaningStartAgentReview: { params: z.object({ id: uuid }) },
  cleaningApproveAgent: {
    params: z.object({ id: uuid }),
    body: CleaningApproveAgentBody,
    bodyRequired: true,
  },
  cleaningRejectAgent: { params: z.object({ id: uuid }), body: CleaningRejectAgentBody, bodyRequired: true },
  cleaningSuspendAgent: {
    params: z.object({ id: uuid }),
    body: CleaningSuspendAgentBody,
    bodyRequired: true,
  },
  cleaningReactivateAgent: { params: z.object({ id: uuid }) },
  cleaningDeactivateAgent: {
    params: z.object({ id: uuid }),
    body: CleaningDeactivateAgentBody,
    bodyRequired: true,
  },
  cleaningGetAgentAvailability: { params: z.object({ id: uuid }) },
  cleaningSetAgentAvailability: {
    params: z.object({ id: uuid }),
    body: CleaningSetAgentAvailabilityBody,
    bodyRequired: true,
  },
  cleaningDeclareAgentUnavailability: {
    params: z.object({ id: uuid }),
    body: CleaningDeclareAgentUnavailabilityBody,
    bodyRequired: true,
  },
  cleaningRemoveAgentUnavailability: { params: z.object({ id: uuid, unavailabilityId: uuid }) },
  cleaningListTeams: {
    query: z.object({
      active: booleanParam.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['name']).optional(),
    }),
  },
  cleaningCreateTeam: { body: CleaningCreateTeamBody, bodyRequired: true },
  cleaningGetTeam: { params: z.object({ id: uuid }) },
  cleaningUpdateTeam: { params: z.object({ id: uuid }), body: CleaningUpdateTeamBody },
  cleaningGetPlanning: {
    query: z.object({
      from: dateTime,
      to: dateTime,
      agentId: uuid.optional(),
      teamId: uuid.optional(),
      zoneKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      programId: uuid.optional(),
    }),
  },
  cleaningListUnassigned: {
    query: z.object({
      zoneKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['urgency']).optional(),
    }),
  },
  cleaningCheckAssignment: { body: CleaningCheckAssignmentBody, bodyRequired: true },
  cleaningCreateAssignments: { body: CleaningCreateAssignmentsBody, bodyRequired: true },
  cleaningUpdateAssignment: {
    params: z.object({ id: uuid }),
    body: CleaningUpdateAssignmentBody,
    bodyRequired: true,
  },
  cleaningRemoveAssignment: {
    params: z.object({ id: uuid }),
    body: CleaningRemoveAssignmentBody,
    bodyRequired: true,
  },
  cleaningRunAutoPlanning: { body: CleaningRunAutoPlanningBody },
  cleaningListProposals: {
    query: z.object({
      zoneKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['start']).optional(),
    }),
  },
  cleaningApproveProposals: { body: CleaningApproveProposalsBody, bodyRequired: true },
  cleaningListPrograms: {
    query: z.object({
      status: z.enum(['confirmed', 'in_progress', 'suspended', 'completed', 'cancelled']).optional(),
      communeKey: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,99}$/u)
        .optional(),
      payerKind: z.enum(['individual', 'organization']).optional(),
      q: z.string().max(50).optional(),
      customerId: uuid.optional(),
      organizationId: uuid.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['-createdAt', 'createdAt']).optional(),
    }),
  },
  cleaningGetProgram: { params: z.object({ id: uuid }) },
  cleaningListProgramSessions: {
    params: z.object({ id: uuid }),
    query: z.object({
      status: z
        .enum([
          'to_assign',
          'assigned',
          'in_progress',
          'interrupted',
          'completed',
          'missed',
          'suspended',
          'cancelled',
        ])
        .optional(),
      paymentStatus: z.enum(['not_due', 'due', 'paid', 'overdue', 'waived']).optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['scheduledStart']).optional(),
    }),
  },
  cleaningGetSession: { params: z.object({ id: uuid }) },
  cleaningChangeProgramSchedule: {
    params: z.object({ id: uuid }),
    body: CleaningChangeProgramScheduleBody,
    bodyRequired: true,
  },
  cleaningCreateAmendment: { params: z.object({ id: uuid }), body: CleaningCreateAmendmentBody },
  cleaningSuspendProgram: {
    params: z.object({ id: uuid }),
    body: CleaningSuspendProgramBody,
    bodyRequired: true,
  },
  cleaningResumeProgram: { params: z.object({ id: uuid }), body: CleaningResumeProgramBody },
  cleaningCancelProgram: {
    params: z.object({ id: uuid }),
    body: CleaningCancelProgramBody,
    bodyRequired: true,
  },
  cleaningApproveProgramCancellation: { params: z.object({ id: uuid }) },
  cleaningRescheduleSessionAsKsp: {
    params: z.object({ id: uuid }),
    body: CleaningRescheduleSessionAsKspBody,
    bodyRequired: true,
  },
  cleaningCancelSessionAsKsp: {
    params: z.object({ id: uuid }),
    body: CleaningCancelSessionAsKspBody,
    bodyRequired: true,
  },
  cleaningResumeSession: { params: z.object({ id: uuid }), body: CleaningResumeSessionBody },
  cleaningCompleteSessionAsKsp: {
    params: z.object({ id: uuid }),
    body: CleaningCompleteSessionAsKspBody,
    bodyRequired: true,
  },
  cleaningReportSessionMissedAsKsp: {
    params: z.object({ id: uuid }),
    body: CleaningReportSessionMissedAsKspBody,
    bodyRequired: true,
  },
  cleaningRemoveSessionPhotoAsKsp: {
    params: z.object({ id: uuid, fileId: uuid }),
    body: CleaningRemoveSessionPhotoAsKspBody,
    bodyRequired: true,
  },
  cleaningListClaims: {
    query: z.object({
      status: z.enum(['open', 'in_progress', 'resolved', 'rejected']).optional(),
      agentId: uuid.optional(),
      customerId: uuid.optional(),
      organizationId: uuid.optional(),
      limit: numberParam(z.number().int().min(1).max(100)).optional(),
      cursor: z.string().max(500).optional(),
      sort: z.enum(['openedAt', '-openedAt']).optional(),
    }),
  },
  cleaningGetClaim: { params: z.object({ id: uuid }) },
  cleaningUpdateClaim: { params: z.object({ id: uuid }), body: CleaningUpdateClaimBody },
  cleaningDecideClaim: { params: z.object({ id: uuid }), body: CleaningDecideClaimBody, bodyRequired: true },
  cleaningApproveClaimCredit: { params: z.object({ id: uuid }) },
  cleaningGetSettings: {},
  cleaningUpdateSettings: { body: CleaningUpdateSettingsBody },
} satisfies Record<CleaningOperationId, CleaningRequestSchema>;
