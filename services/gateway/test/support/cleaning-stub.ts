import { cleaningV1 } from '@ksp/contracts';
import {
  currentContext,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  type RequestContext,
  ServiceTokenVerifier,
} from '@ksp/platform';
import { Controller, Inject, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions } from '@nestjs/microservices';
import { createLocalJWKSet } from 'jose';
import { freePort, type TestKeys, USER_ID } from './harness';

/**
 * Service cleaning simulé pour les tests de la gateway : implémente les contrôleurs générés depuis
 * cleaning.proto, vérifie le jeton de service comme le vrai service, et répond des messages complets.
 */
export const IDS = {
  request: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1001',
  mission: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000',
  quote: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d3001',
  intervention: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d4001',
  agent: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002',
  team: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001',
  group: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001',
  sibling: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1002',
  groupVisit: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d8001',
  visit: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d8002',
};

/** Position fictive (ADR-034). */
export const LOCATION = { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 15 };

const xof = (amount: number) => ({ amount, currency: 'XOF' });
const SLOT = { start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T11:00:00.000Z' };

/** Plan de passages (ADR-052) : chaque jeudi à 09:00, du 5 au 12 novembre 2026, soit deux passages. */
export const protoSchedule: cleaningV1.InterventionSchedule = {
  mode: 'weekly',
  dates: [],
  startDate: '2026-11-05',
  endDate: '2026-11-12',
  weekdays: ['thu'],
  everyWeeks: 1,
  monthDays: [],
  weeksOfMonth: [],
  startTime: '09:00',
  excludedDates: [],
  extraDates: [],
};
export const SCHEDULED_DATES = ['2026-11-05', '2026-11-12'];
export const protoSchedulePreview: cleaningV1.SchedulePreview = {
  dates: SCHEDULED_DATES,
  count: 2,
  firstDate: '2026-11-05',
  lastDate: '2026-11-12',
  warnings: [],
};

/** Détail du calcul (ADR-033) : 6 pièces × 4 500 + 1 salle de bain × 3 000 + 8 fenêtres × 500, × 1,05. */
export const protoCalculation: cleaningV1.PriceCalculation = {
  pricingVersion: 3,
  priced: true,
  reason: '',
  missingPrices: [],
  lines: [
    {
      kind: 'unit_price',
      optionCode: '',
      fieldCode: 'rooms',
      choiceCode: '',
      label: 'Nombre de pièces',
      quantity: 6,
      unitLabel: 'pièces',
      unitPrice: xof(4500),
      amount: xof(27000),
    },
    {
      kind: 'unit_price',
      optionCode: 'windows',
      fieldCode: 'window_count',
      choiceCode: '',
      label: 'Vitres — nombre de fenêtres',
      quantity: 8,
      unitLabel: 'fenêtres',
      unitPrice: xof(500),
      amount: xof(4000),
    },
  ],
  baseAmount: xof(31000),
  coefficients: [
    {
      source: 'commune',
      optionCode: '',
      fieldCode: '',
      code: 'abomey-calavi',
      label: 'Abomey-Calavi',
      coefficientBp: 10500,
    },
  ],
  subtotal: xof(32550),
  minimumPrice: xof(15000),
  minimumApplied: false,
  computedPrice: xof(32550),
  estimate: { low: xof(29500), high: xof(37500) },
  recommendedTeamSize: 2,
};
export const protoAnswers: cleaningV1.AnswerSet = {
  values: {
    housing_type: { choiceValue: 'apartment' },
    rooms: { numberValue: 6 },
    pets: { booleanValue: false },
  },
};

/** Réponses lisibles du client (ADR-037). */
export const protoAnswerSummary: cleaningV1.AnswerSummary = {
  fields: [
    {
      code: 'housing_type',
      label: 'Type de logement',
      type: 'choice',
      value: { choiceValue: 'apartment' },
      display: 'Appartement',
      unitLabel: '',
    },
    {
      code: 'rooms',
      label: 'Nombre de pièces',
      type: 'number',
      value: { numberValue: 6 },
      display: '6 pièces',
      unitLabel: 'pièces',
    },
    {
      code: 'pets',
      label: "Présence d'animaux",
      type: 'boolean',
      value: { booleanValue: false },
      display: 'Non',
      unitLabel: '',
    },
  ],
  options: [
    {
      optionCode: 'windows',
      label: 'Vitres',
      fields: [
        {
          code: 'window_count',
          label: 'Nombre de fenêtres',
          type: 'number',
          value: { numberValue: 8 },
          display: '8 fenêtres',
          unitLabel: 'fenêtres',
        },
      ],
    },
  ],
  frequency: { code: 'once', label: 'Une fois' },
};

/** Mesures constatées après la visite (ADR-037) : 8 pièces au lieu de 6. */
export const protoMeasurement: cleaningV1.RequestMeasurement = {
  answers: { values: { ...protoAnswers.values, rooms: { numberValue: 8 } } },
  optionSelections: [{ code: 'windows', answers: { values: { window_count: { numberValue: 8 } } } }],
  frequency: 'once',
  calculation: { ...protoCalculation, computedPrice: xof(45150) },
  pricingVersion: 3,
  measuredAt: '2026-10-26T10:00:00.000Z',
  measuredBy: IDS.agent,
  measuredByName: 'Awa Dossou',
};

export const protoRequest: cleaningV1.QuoteRequest = {
  id: IDS.request,
  status: 'quote_sent',
  customerId: USER_ID,
  customerKind: 'individual',
  organizationId: '',
  serviceCode: 'home_cleaning',
  premisesType: 'house',
  quantity: 6,
  options: ['windows'],
  commune: 'Abomey-Calavi',
  address: 'Lot 12, Abomey-Calavi',
  preferredSlots: [SLOT],
  comment: '',
  requestedTeamSize: 0,
  daysPerWeek: 0,
  recommendedTeamSize: 2,
  estimate: { low: xof(32000), high: xof(41000) },
  quote: {
    id: IDS.quote,
    lines: [{ label: 'Nettoyage à domicile', quantity: 6, unitPrice: xof(5000), amount: xof(30000) }],
    subtotal: xof(30000),
    interventionCount: 1,
    total: xof(30000),
    proposedSlots: [SLOT],
    validUntil: '2026-11-07T08:00:00.000Z',
    depositPercent: 30,
    depositAmount: xof(9000),
    sentAt: '2026-10-23T08:00:00.000Z',
    teamSize: 2,
    durationMinutes: 180,
    scheduledDates: [],
  },
  schedule: protoSchedule,
  scheduledDates: SCHEDULED_DATES,
  missionId: '',
  closingReason: '',
  createdAt: '2026-10-22T10:00:00.000Z',
  updatedAt: '2026-10-23T08:00:00.000Z',
  customerName: 'Koffi Adjovi',
  organizationName: '',
  answers: protoAnswers,
  optionSelections: [{ code: 'windows', answers: { values: { window_count: { numberValue: 8 } } } }],
  frequency: 'once',
  pricingVersion: 3,
  calculation: protoCalculation,
  groupId: IDS.group,
  placeType: 'house',
  location: LOCATION,
  landmark: 'Portail bleu',
  geocodingProvider: 'nominatim',
  groupSize: 2,
  serviceName: 'Nettoyage à domicile',
  placeTypeLabel: 'Maison',
  answerSummary: protoAnswerSummary,
  measurement: protoMeasurement,
  measuredSummary: {
    ...protoAnswerSummary,
    fields: protoAnswerSummary.fields.map((field) =>
      field.code === 'rooms' ? { ...field, value: { numberValue: 8 }, display: '8 pièces' } : field,
    ),
  },
  geocodedAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
};

export const protoMission: cleaningV1.Mission = {
  id: IDS.mission,
  requestId: IDS.request,
  quoteId: IDS.quote,
  customerId: USER_ID,
  status: 'scheduled',
  serviceCode: 'home_cleaning',
  commune: 'Abomey-Calavi',
  address: 'Lot 12, Abomey-Calavi',
  chosenSlot: SLOT,
  plannedInterventions: 2,
  completedInterventions: 0,
  recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 1 },
  schedule: protoSchedule,
  scheduledDates: SCHEDULED_DATES,
  interventions: [
    {
      id: IDS.intervention,
      status: 'planned',
      scheduledStart: SLOT.start,
      durationMinutes: 180,
      agents: [{ agentId: IDS.agent, displayName: 'Awa B.' }],
      checklist: [{ code: 'arrival', label: 'Arrivée', done: false }],
      incidentNote: '',
      beforePhotoFileIds: [],
      afterPhotoFileIds: [],
      startedAt: '',
      completedAt: '',
      cancellationCause: '',
    },
  ],
  payment: {
    plan: { option: 'deposit', timing: 'before', method: 'cash' },
    status: 'due',
    total: xof(60000),
    depositPercent: 30,
    depositAmount: xof(18000),
    paid: xof(0),
    payments: [],
    remainingDue: xof(60000),
    depositDue: xof(18000),
  },
  cancellationReason: '',
  daysPerWeek: 2,
  suspension: {
    cause: 'unpaid_invoices',
    since: '2026-12-15T06:00:00.000Z',
    unpaidCount: 2,
    causes: ['unpaid_invoices', 'organization_suspended'],
  },
  createdAt: '2026-10-23T09:00:00.000Z',
  updatedAt: '2026-10-23T09:00:00.000Z',
  customerKind: 'business',
  organizationId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000',
  customerName: 'Koffi Adjovi',
  organizationName: 'SARL Bénin Propre',
  location: LOCATION,
  landmark: 'Portail bleu',
  groupId: IDS.group,
  placeType: 'house',
};

const definition: cleaningV1.ServiceDefinition = {
  code: 'home_cleaning',
  name: 'Nettoyage à domicile',
  description: '',
  unit: 'room',
  active: true,
  pricing: {
    version: 1,
    unitPrice: xof(4500),
    options: [{ code: 'windows', label: 'Vitres' }],
    communeCoefficients: [],
    defaultCoefficientBp: 10000,
    frequencies: [{ code: 'once', label: 'Une fois', coefficientBp: 10000, active: true }],
    teamSize: { fieldCode: 'rooms', unitsPerAgent: 3, minAgents: 1, maxAgents: 6 },
    checklist: [],
    updatedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
    updatedAt: '2026-10-23T08:00:00.000Z',
    updatedByName: 'Afi Superviseure',
  },
  fields: [
    {
      code: 'rooms',
      label: 'Nombre de pièces',
      type: 'number',
      required: true,
      helpText: '',
      active: true,
      unitLabel: 'pièces',
      min: 1,
      max: 50,
      pricePerUnit: xof(4500),
      choices: [],
      coefficientBpIfYes: 0,
    },
    {
      code: 'condition',
      label: 'État',
      type: 'choice',
      required: true,
      helpText: '',
      active: true,
      unitLabel: '',
      min: 0,
      max: 0,
      choices: [
        { code: 'normal', label: 'Normal', supplement: xof(0), coefficientBp: 0, active: true },
        { code: 'dirty', label: 'Sale', coefficientBp: 12000, active: true },
      ],
      coefficientBpIfYes: 0,
    },
    {
      code: 'pets',
      label: "Présence d'animaux",
      type: 'boolean',
      required: false,
      helpText: '',
      active: true,
      unitLabel: '',
      min: 0,
      max: 0,
      choices: [],
      coefficientBpIfYes: 11000,
    },
  ],
  options: [
    {
      code: 'windows',
      label: 'Vitres',
      description: '',
      active: true,
      fields: [
        {
          code: 'window_count',
          label: 'Nombre de fenêtres',
          type: 'number',
          required: true,
          helpText: '',
          active: true,
          unitLabel: 'fenêtres',
          min: 1,
          max: 200,
          pricePerUnit: xof(500),
          choices: [],
          coefficientBpIfYes: 0,
        },
      ],
    },
  ],
};
const settings: cleaningV1.Settings = {
  quoteValidityDays: 15,
  minimumLeadHours: 48,
  freeCancellationHours: 24,
  visitThresholdSquareMeters: 300,
  maxOpenRequests: 5,
  depositPercent: 30,
  businessWarningUnpaidInvoices: 1,
  businessSuspensionUnpaidInvoices: 2,
  individualSuspensionUnpaidInterventions: 1,
  individualPaymentGraceHours: 24,
  locationRetentionMonths: 12,
  updatedBy: '',
  updatedAt: '',
  updatedByName: '',
};
const zone: cleaningV1.Zone = {
  code: 'abomey-calavi',
  commune: 'Abomey-Calavi',
  aliases: ['Abomey Calavi'],
  active: true,
  openRequests: 3,
  activeMissions: 1,
  updatedBy: '',
  updatedAt: '',
  updatedByName: '',
};
const agent: cleaningV1.Agent = {
  agentId: IDS.agent,
  displayName: 'Awa B.',
  active: true,
  unavailabilities: [],
};
const team: cleaningV1.Team = {
  id: IDS.team,
  name: 'Équipe Calavi',
  members: [{ agentId: IDS.agent, displayName: 'Awa B.' }],
};

type Method =
  | keyof cleaningV1.CatalogServiceController
  | keyof cleaningV1.QuoteServiceController
  | keyof cleaningV1.MissionServiceController
  | keyof cleaningV1.CleaningAdminServiceController;

const withRequest = () => ({ request: protoRequest });
const placeType: cleaningV1.PlaceType = {
  code: 'house',
  label: 'Maison',
  description: 'Maison individuelle, avec ou sans cour.',
  icon: 'house',
  displayOrder: 10,
  active: true,
  serviceCodes: ['home_cleaning', 'garden_maintenance', 'old_service'],
  updatedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
  updatedAt: '2026-11-03T08:00:00.000Z',
  updatedByName: 'Afi Superviseure',
  unknownServiceCodes: ['old_service'],
  inactiveServiceCodes: ['garden_maintenance'],
  publiclyVisible: true,
  visibilityReason: '',
};
const protoGroup: cleaningV1.QuoteRequestGroup = {
  id: IDS.group,
  placeType: 'house',
  commune: 'Abomey-Calavi',
  zoneCode: 'abomey-calavi',
  createdAt: '2026-10-22T10:00:00.000Z',
  requests: [
    protoRequest,
    {
      ...protoRequest,
      id: IDS.sibling,
      serviceCode: 'garden_maintenance',
      serviceName: 'Entretien de jardin',
      quote: undefined,
      status: 'received',
    },
  ],
};
const withMission = () => ({ mission: protoMission });
/** Résultat d'une opération de groupe (ADR-035). */
export const protoOutcome: cleaningV1.RequestGroupOutcome = {
  groupId: IDS.group,
  affectedRequestIds: [IDS.request],
  skipped: [{ requestId: IDS.sibling, status: 'accepted', reason: 'not_open' }],
  groupVisitId: '',
  missionIds: [],
};
const withOutcome = () => ({ outcome: protoOutcome, requests: protoGroup.requests });
const withGroupOutcome = () => ({ outcome: protoOutcome, group: protoGroup });

/** Visite commune vue par la supervision (ADR-035), demandes avec réponses et mesures (ADR-037). */
export const protoVisit: cleaningV1.VisitSummary = {
  id: IDS.groupVisit,
  groupVisitId: IDS.groupVisit,
  groupId: IDS.group,
  status: 'scheduled',
  scheduledAt: '2026-10-26T09:00:00.000Z',
  completedAt: '',
  report: '',
  agentId: IDS.agent,
  agentName: 'Awa Agent',
  customerId: USER_ID,
  customerName: 'Koffi Adjovi',
  organizationName: '',
  commune: 'Abomey-Calavi',
  address: 'Portail bleu',
  location: LOCATION,
  landmark: 'Portail bleu',
  geocodedAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
  placeType: 'house',
  placeTypeLabel: 'Maison',
  requests: [
    {
      requestId: IDS.request,
      visitId: IDS.visit,
      serviceCode: 'home_cleaning',
      serviceName: 'Nettoyage à domicile',
      status: 'visit_scheduled',
      placeType: 'house',
      placeTypeLabel: 'Maison',
      answers: protoAnswers,
      optionSelections: protoRequest.optionSelections,
      frequency: 'once',
      pricingVersion: 3,
      answerSummary: protoAnswerSummary,
      // Vue de la supervision : montants présents (absents pour un agent, voir le test).
      calculation: protoCalculation,
      measurement: protoMeasurement,
      measuredSummary: protoAnswerSummary,
    },
  ],
};

const DEFAULTS: Record<Method, () => unknown> = {
  listServices: () => ({
    services: [
      {
        code: 'home_cleaning',
        name: 'Nettoyage à domicile',
        description: '',
        unit: 'room',
        options: [],
        priced: false,
        form: {
          fields: [
            {
              code: 'rooms',
              label: 'Nombre de pièces',
              type: 'number',
              required: true,
              helpText: '',
              unitLabel: 'pièces',
              min: 1,
              max: 50,
              choices: [],
            },
            {
              code: 'condition',
              label: 'État',
              type: 'choice',
              required: true,
              helpText: 'Selon la dernière remise en état.',
              unitLabel: '',
              min: 0,
              max: 0,
              choices: [
                { code: 'normal', label: 'Normal' },
                { code: 'dirty', label: 'Sale' },
              ],
            },
          ],
          options: [{ code: 'appliances', label: 'Électroménager', description: '', fields: [] }],
          frequencies: [{ code: 'once', label: 'Une fois' }],
        },
      },
    ],
  }),
  simulate: () => ({
    serviceCode: 'home_cleaning',
    priced: true,
    estimate: { low: xof(33500), high: xof(43000) },
    computedPrice: xof(37400),
    breakdown: [{ label: 'Nettoyage à domicile', quantity: 6, unitPrice: xof(5000), amount: xof(30000) }],
    minimumApplied: false,
    communeCoefficientBp: 11000,
    recommendedTeamSize: 2,
    notice: 'Estimation non contractuelle.',
    covered: true,
    reason: '',
    calculation: protoCalculation,
    communeApplied: true,
  }),
  previewSchedule: () => ({ preview: protoSchedulePreview }),
  getPlaceCatalog: () => ({
    placeTypes: [
      {
        code: 'house',
        label: 'Maison',
        description: 'Maison individuelle, avec ou sans cour.',
        icon: 'house',
        displayOrder: 10,
        serviceCodes: ['home_cleaning'],
      },
    ],
    services: (DEFAULTS.listServices() as { services: unknown[] }).services,
  }),
  estimate: () => ({
    placeType: 'house',
    commune: '',
    communeApplied: false,
    covered: false,
    status: 'priced',
    total: xof(31000),
    notice: 'Estimation indicative, sans commune.',
    items: [
      {
        serviceCode: 'home_cleaning',
        serviceName: 'Nettoyage à domicile',
        priced: true,
        reason: '',
        notice: 'Estimation indicative, sans commune.',
        calculation: {
          ...protoCalculation,
          coefficients: [],
          subtotal: xof(31000),
          computedPrice: xof(31000),
        },
      },
    ],
  }),
  resolveLocation: () => ({
    latitude: LOCATION.latitude,
    longitude: LOCATION.longitude,
    commune: 'Abomey-Calavi',
    zoneCode: 'abomey-calavi',
    served: true,
    displayAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
    provider: 'nominatim',
  }),
  requestQuoteGroup: () => ({ group: protoGroup }),
  getRequestGroup: () => ({ group: protoGroup }),
  cancelRequestGroup: withGroupOutcome,
  acceptGroupQuotes: () => ({
    outcome: { ...protoOutcome, missionIds: [IDS.mission] },
    group: { ...protoGroup, quotesTotal: xof(30000), remainingDue: xof(30000) },
  }),
  scheduleGroupVisit: () => ({
    outcome: { ...protoOutcome, groupVisitId: IDS.groupVisit },
    requests: protoGroup.requests,
  }),
  completeGroupVisit: withOutcome,
  rejectRequestGroup: withOutcome,
  sendGroupQuotes: withOutcome,
  correctRequestLocation: () => ({
    request: protoRequest,
    updatedRequestIds: [IDS.request, IDS.sibling],
    updatedMissionIds: [IDS.mission],
  }),
  listVisits: () => ({ visits: [protoVisit], nextCursor: '' }),
  scheduleGroupInterventions: () => ({
    groupId: IDS.group,
    scheduledMissionIds: [IDS.mission],
    skipped: [],
    missions: [protoMission],
  }),
  listPlaceTypes: () => ({ placeTypes: [placeType] }),
  savePlaceType: () => ({ placeType }),
  listServedZones: () => ({
    zones: [
      { code: 'abomey-calavi', commune: 'Abomey-Calavi' },
      { code: 'cotonou', commune: 'Cotonou' },
    ],
  }),
  requestQuote: withRequest,
  listMyRequests: () => ({ requests: [protoRequest], nextCursor: '' }),
  getRequest: withRequest,
  acceptQuote: () => ({
    request: { ...protoRequest, status: 'accepted', missionId: IDS.mission },
    mission: protoMission,
  }),
  declineQuote: withRequest,
  cancelRequest: withRequest,
  listMyMissions: () => ({ missions: [protoMission], nextCursor: IDS.mission }),
  getMission: withMission,
  cancelMission: withMission,
  payMissionFromWallet: withMission,
  listQuoteRequests: () => ({ requests: [protoRequest], nextCursor: '' }),
  getQuoteRequest: () => ({
    request: protoRequest,
    groupRequests: [
      {
        id: IDS.sibling,
        serviceCode: 'garden_maintenance',
        status: 'visit_scheduled',
        serviceName: 'Entretien de jardin',
        visitScheduledAt: '2026-10-26T09:00:00.000Z',
        missionId: '',
      },
    ],
  }),
  rejectQuoteRequest: withRequest,
  scheduleVisit: withRequest,
  completeVisit: withRequest,
  estimateRequestPrice: () => ({
    requestId: IDS.request,
    serviceCode: 'home_cleaning',
    commune: 'Abomey-Calavi',
    calculation: protoMeasurement.calculation,
  }),
  saveRequestMeasurements: withRequest,
  sendQuote: withRequest,
  listMissions: () => ({ missions: [protoMission], nextCursor: '' }),
  getMissionDetail: withMission,
  scheduleIntervention: withMission,
  startIntervention: withMission,
  updateChecklist: withMission,
  reportIncident: withMission,
  resumeIntervention: withMission,
  completeIntervention: withMission,
  recordPayment: withMission,
  cancelMissionAsSupervisor: withMission,
  getCatalog: () => ({ services: [definition], settings, unplacedServiceCodes: ['pest_control'] }),
  saveService: () => ({ service: definition, affectedPlaceTypes: [] }),
  previewService: () => ({ serviceCode: 'home_cleaning', calculation: protoCalculation, covered: true }),
  updateSettings: () => ({ settings }),
  listZones: () => ({ zones: [zone] }),
  saveZone: () => ({ zone }),
  deactivateZone: () => ({ zone: { ...zone, active: false } }),
  listAgents: () => ({ agents: [agent] }),
  registerAgent: () => ({ agent }),
  declareUnavailability: () => ({ agent }),
  listTeams: () => ({ teams: [team] }),
  createTeam: () => ({ team }),
  updateTeam: () => ({ team }),
};

/** Réponse par défaut d'une méthode, pour la compléter dans un test. */
export const stubDefault = (method: Method) => DEFAULTS[method]() as object;

export class CleaningStub {
  readonly calls: {
    method: Method;
    request: Record<string, unknown>;
    context: RequestContext | undefined;
  }[] = [];
  private readonly overrides = new Map<Method, (request: Record<string, unknown>) => Promise<unknown>>();

  on(method: Method, handler: (request: Record<string, unknown>) => Promise<unknown>): void {
    this.overrides.set(method, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  last(method: Method) {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async handle(method: Method, request: object): Promise<never> {
    this.calls.push({ method, request: { ...request }, context: currentContext() });
    const override = this.overrides.get(method);
    return (override ? await override({ ...request }) : DEFAULTS[method]()) as never;
  }
}

const STUB = Symbol('CLEANING_STUB');

/** Contrôleur générique : chaque méthode du contrat délègue au service simulé. */
function stubController(methods: readonly Method[], decorate: () => ClassDecorator) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: CleaningStub) {}
  }
  for (const method of methods) {
    Object.defineProperty(StubController.prototype, method, {
      value(this: StubController, request: object) {
        return this.stub.handle(method, request);
      },
    });
  }
  // Les décorateurs générés lisent les méthodes du prototype : on les applique après les avoir posées.
  decorate()(StubController);
  return StubController;
}

export interface CleaningServer {
  stub: CleaningStub;
  url: string;
  close(): Promise<void>;
}

export async function startCleaningStub(keys: TestKeys): Promise<CleaningServer> {
  const stub = new CleaningStub();
  const all = Object.keys(DEFAULTS) as Method[];
  const pick = (names: string[]) => all.filter((m) => names.includes(m));

  @Module({
    controllers: [
      stubController(
        pick([
          'listServices',
          'simulate',
          'previewSchedule',
          'listServedZones',
          'getPlaceCatalog',
          'estimate',
        ]),
        cleaningV1.CatalogServiceControllerMethods,
      ),
      stubController(
        pick([
          'requestQuote',
          'listMyRequests',
          'getRequest',
          'acceptQuote',
          'declineQuote',
          'cancelRequest',
          'resolveLocation',
          'requestQuoteGroup',
          'getRequestGroup',
          'cancelRequestGroup',
          'acceptGroupQuotes',
        ]),
        cleaningV1.QuoteServiceControllerMethods,
      ),
      stubController(
        pick(['listMyMissions', 'getMission', 'cancelMission', 'payMissionFromWallet']),
        cleaningV1.MissionServiceControllerMethods,
      ),
      stubController(
        all.filter(
          (m) =>
            ![
              'listServices',
              'simulate',
              'previewSchedule',
              'listServedZones',
              'getPlaceCatalog',
              'estimate',
              'resolveLocation',
              'requestQuoteGroup',
              'getRequestGroup',
              'cancelRequestGroup',
              'acceptGroupQuotes',
              'requestQuote',
              'listMyRequests',
              'getRequest',
              'acceptQuote',
              'declineQuote',
              'cancelRequest',
              'listMyMissions',
              'getMission',
              'cancelMission',
              'payMissionFromWallet',
            ].includes(m),
        ),
        cleaningV1.CleaningAdminServiceControllerMethods,
      ),
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['cleaning'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'cleaning',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
