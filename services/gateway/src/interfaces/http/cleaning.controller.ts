import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { type CleaningApi, type Page } from '../../application/cleaning/cleaning.ports';
import { RequestCleaningQuoteUseCase } from '../../application/cleaning/request-cleaning-quote.use-case';
import { CLEANING_API } from '../../tokens';
import { cleaningParams, parseParam } from './cleaning-schemas';
import { Route } from './route.decorator';
import { isEmptyBody, parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

export const pageFrom = (query: Query): Page =>
  parseParam(cleaningParams.page, { limit: query['limit'], cursor: query['cursor'] }, 'limit/cursor');
export const idFrom = (id: unknown) => parseParam(cleaningParams.id, id, 'id');
export const keyFrom = (key: unknown) => parseParam(cleaningParams.idempotencyKey, key, 'Idempotency-Key');
/** Corps facultatif (motif d'annulation…) : absent, vide, ou conforme au schéma. */
export const optionalBody = <T>(schema: Parameters<typeof parseBody>[0], body: unknown): T =>
  (isEmptyBody(body) ? {} : parseBody(schema, body)) as T;

/**
 * Routes /api/v1/cleaning/* (contrat OpenAPI) : simulateur public et espace client. Validation des
 * paramètres et du corps, puis appel de cleaning ; le service revérifie toujours ses droits.
 */
@Controller()
export class CleaningHttpController {
  constructor(
    @Inject(CLEANING_API) private readonly cleaning: CleaningApi,
    private readonly requestQuoteUseCase: RequestCleaningQuoteUseCase,
  ) {}

  @Route('listCleaningServices')
  listServices() {
    return this.cleaning.listServices();
  }

  @Route('listServedCleaningZones')
  listServedZones() {
    return this.cleaning.listServedZones();
  }

  @Route('simulateCleaning')
  simulate(@Body() body: unknown) {
    return this.cleaning.simulate(parseBody(requestBodies.simulateCleaning, body));
  }

  @Route('requestCleaningQuote')
  requestQuote(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const idempotencyKey = keyFrom(key);
    return this.requestQuoteUseCase.execute(
      parseBody(requestBodies.requestCleaningQuote, body),
      idempotencyKey,
    );
  }

  @Route('listMyCleaningRequests')
  listMyRequests(@Query() query: Query) {
    return this.cleaning.listMyRequests(pageFrom(query));
  }

  @Route('getMyCleaningRequest')
  getMyRequest(@Param('id') id: unknown) {
    return this.cleaning.getMyRequest(idFrom(id));
  }

  @Route('acceptCleaningQuote')
  acceptQuote(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    const requestId = idFrom(id);
    const idempotencyKey = keyFrom(key);
    return this.cleaning.acceptQuote(
      requestId,
      parseBody(requestBodies.acceptCleaningQuote, body),
      idempotencyKey,
    );
  }

  @Route('declineCleaningQuote')
  declineQuote(@Param('id') id: unknown, @Body() body: unknown) {
    const requestId = idFrom(id);
    const input = optionalBody<{ reason?: string }>(requestBodies.declineCleaningQuote, body);
    return this.cleaning.declineQuote(requestId, input.reason);
  }

  @Route('cancelCleaningRequest')
  cancelRequest(@Param('id') id: unknown, @Body() body: unknown) {
    const requestId = idFrom(id);
    const input = optionalBody<{ reason?: string }>(requestBodies.cancelCleaningRequest, body);
    return this.cleaning.cancelRequest(requestId, input.reason);
  }

  @Route('listMyCleaningMissions')
  listMyMissions(@Query() query: Query) {
    return this.cleaning.listMyMissions(pageFrom(query));
  }

  @Route('getMyCleaningMission')
  getMyMission(@Param('id') id: unknown) {
    return this.cleaning.getMyMission(idFrom(id));
  }

  @Route('cancelMyCleaningMission')
  cancelMyMission(@Param('id') id: unknown, @Body() body: unknown) {
    const missionId = idFrom(id);
    const input = optionalBody<{ reason?: string }>(requestBodies.cancelMyCleaningMission, body);
    return this.cleaning.cancelMyMission(missionId, input.reason);
  }
}
