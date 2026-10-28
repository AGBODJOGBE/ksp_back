import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { type CleaningApi } from '../../application/cleaning/cleaning.ports';
import { CLEANING_API } from '../../tokens';
import { idFrom, pageFrom } from './cleaning.controller';
import { cleaningParams, parseParam } from './cleaning-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

/**
 * Routes /api/v1/admin/cleaning/* (back-office, UC-CL-06 à 12). Rôles et double authentification
 * contrôlés par le garde d'après le manifeste, puis revérifiés par cleaning (un agent ne voit que
 * ses passages).
 */
@Controller()
export class CleaningAdminHttpController {
  constructor(@Inject(CLEANING_API) private readonly cleaning: CleaningApi) {}

  // --- Demandes, visites, devis ---------------------------------------------------------------

  @Route('listCleaningQuoteRequests')
  listQuoteRequests(@Query() query: Query) {
    const status = parseParam(cleaningParams.requestStatus, query['status'], 'status');
    const commune = parseParam(cleaningParams.communeFilter, query['commune'], 'commune');
    const customerKind = parseParam(cleaningParams.customerKind, query['customerKind'], 'customerKind');
    return this.cleaning.listQuoteRequests(pageFrom(query), { status, commune, customerKind });
  }

  @Route('getCleaningQuoteRequest')
  getQuoteRequest(@Param('id') id: unknown) {
    return this.cleaning.getQuoteRequest(idFrom(id));
  }

  @Route('rejectCleaningQuoteRequest')
  rejectQuoteRequest(@Param('id') id: unknown, @Body() body: unknown) {
    const requestId = idFrom(id);
    return this.cleaning.rejectQuoteRequest(
      requestId,
      parseBody(requestBodies.rejectCleaningQuoteRequest, body).reason,
    );
  }

  @Route('scheduleCleaningVisit')
  scheduleVisit(@Param('id') id: unknown, @Body() body: unknown) {
    const requestId = idFrom(id);
    return this.cleaning.scheduleVisit(requestId, parseBody(requestBodies.scheduleCleaningVisit, body));
  }

  @Route('completeCleaningVisit')
  completeVisit(@Param('id') id: unknown, @Body() body: unknown) {
    const visitId = idFrom(id);
    return this.cleaning.completeVisit(visitId, parseBody(requestBodies.completeCleaningVisit, body).report);
  }

  @Route('sendCleaningQuote')
  sendQuote(@Param('id') id: unknown, @Body() body: unknown) {
    const requestId = idFrom(id);
    return this.cleaning.sendQuote(requestId, parseBody(requestBodies.sendCleaningQuote, body));
  }

  // --- Missions et passages --------------------------------------------------------------------

  @Route('listCleaningMissions')
  listMissions(@Query() query: Query) {
    const status = parseParam(cleaningParams.missionStatus, query['status'], 'status');
    return this.cleaning.listMissions(pageFrom(query), status);
  }

  @Route('getCleaningMission')
  getMission(@Param('id') id: unknown) {
    return this.cleaning.getMission(idFrom(id));
  }

  @Route('scheduleCleaningIntervention')
  scheduleIntervention(@Param('id') id: unknown, @Body() body: unknown) {
    const missionId = idFrom(id);
    return this.cleaning.scheduleIntervention(
      missionId,
      parseBody(requestBodies.scheduleCleaningIntervention, body),
    );
  }

  @Route('recordCleaningPayment')
  recordPayment(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const missionId = idFrom(id);
    // Facultative : les envois sans clé restent acceptés (back-office déjà branché).
    const idempotencyKey = parseParam(cleaningParams.optionalIdempotencyKey, key, 'Idempotency-Key');
    return this.cleaning.recordPayment(
      missionId,
      parseBody(requestBodies.recordCleaningPayment, body),
      idempotencyKey,
    );
  }

  @Route('cancelCleaningMission')
  cancelMission(@Param('id') id: unknown, @Body() body: unknown) {
    const missionId = idFrom(id);
    return this.cleaning.cancelMission(
      missionId,
      parseBody(requestBodies.cancelCleaningMission, body).reason,
    );
  }

  @Route('startCleaningIntervention')
  startIntervention(@Param('id') id: unknown) {
    return this.cleaning.startIntervention(idFrom(id));
  }

  @Route('updateCleaningChecklist')
  updateChecklist(@Param('id') id: unknown, @Body() body: unknown) {
    const interventionId = idFrom(id);
    return this.cleaning.updateChecklist(
      interventionId,
      parseBody(requestBodies.updateCleaningChecklist, body).doneCodes,
    );
  }

  @Route('reportCleaningIncident')
  reportIncident(@Param('id') id: unknown, @Body() body: unknown) {
    const interventionId = idFrom(id);
    return this.cleaning.reportIncident(
      interventionId,
      parseBody(requestBodies.reportCleaningIncident, body).note,
    );
  }

  @Route('resumeCleaningIntervention')
  resumeIntervention(@Param('id') id: unknown) {
    return this.cleaning.resumeIntervention(idFrom(id));
  }

  @Route('completeCleaningIntervention')
  completeIntervention(@Param('id') id: unknown) {
    return this.cleaning.completeIntervention(idFrom(id));
  }

  // --- Catalogue, réglages, agents, équipes --------------------------------------------------

  @Route('getCleaningCatalog')
  getCatalog() {
    return this.cleaning.getCatalog();
  }

  @Route('saveCleaningService')
  saveService(@Param('code') code: unknown, @Body() body: unknown) {
    const serviceCode = parseParam(cleaningParams.serviceCode, code, 'code');
    return this.cleaning.saveService(serviceCode, parseBody(requestBodies.saveCleaningService, body));
  }

  @Route('updateCleaningSettings')
  updateSettings(@Body() body: unknown) {
    return this.cleaning.updateSettings(parseBody(requestBodies.updateCleaningSettings, body));
  }

  // --- Zones desservies ------------------------------------------------------------------------

  @Route('listCleaningZones')
  listZones() {
    return this.cleaning.listZones();
  }

  @Route('saveCleaningZone')
  saveZone(@Body() body: unknown) {
    return this.cleaning.saveZone(parseBody(requestBodies.saveCleaningZone, body).commune);
  }

  @Route('deactivateCleaningZone')
  deactivateZone(@Param('code') code: unknown) {
    return this.cleaning.deactivateZone(parseParam(cleaningParams.zoneCode, code, 'code'));
  }

  @Route('listCleaningAgents')
  listAgents() {
    return this.cleaning.listAgents();
  }

  @Route('registerCleaningAgent')
  registerAgent(@Body() body: unknown) {
    return this.cleaning.registerAgent(parseBody(requestBodies.registerCleaningAgent, body));
  }

  @Route('declareCleaningUnavailability')
  declareUnavailability(@Param('id') id: unknown, @Body() body: unknown) {
    const agentId = idFrom(id);
    return this.cleaning.declareUnavailability(
      agentId,
      parseBody(requestBodies.declareCleaningUnavailability, body),
    );
  }

  @Route('listCleaningTeams')
  listTeams() {
    return this.cleaning.listTeams();
  }

  @Route('createCleaningTeam')
  createTeam(@Body() body: unknown) {
    return this.cleaning.createTeam(parseBody(requestBodies.createCleaningTeam, body));
  }

  @Route('updateCleaningTeam')
  updateTeam(@Param('id') id: unknown, @Body() body: unknown) {
    const teamId = idFrom(id);
    return this.cleaning.updateTeam(teamId, parseBody(requestBodies.updateCleaningTeam, body));
  }
}
