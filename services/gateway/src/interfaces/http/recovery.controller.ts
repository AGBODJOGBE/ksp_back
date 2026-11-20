import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { type RecoveryApi } from '../../application/recovery/recovery.ports';
import { RECOVERY_API } from '../../tokens';
import {
  idFrom,
  keyFrom,
  queryFrom,
  rowFrom,
  sessionFrom,
  tokenFrom,
  type QueryParams,
} from './recovery-params';
import { recoveryQueries } from './recovery-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes /api/v1/recovery/* (ADR-060, ADR-061) : espace du créancier connecté, espace du débiteur
 * sans compte (session dans l'en-tête X-Debtor-Session, jamais journalisée) et accès des huissiers
 * et avocats partenaires. Validation des paramètres et du corps, puis appel de recovery, qui
 * revérifie toujours ses droits.
 */
@Controller()
export class RecoveryHttpController {
  constructor(@Inject(RECOVERY_API) private readonly recovery: RecoveryApi) {}

  // --- Créancier -----------------------------------------------------------------------------------

  @Route('recoveryEstimateCaseFees')
  estimateCaseFees(@Body() body: unknown) {
    return this.recovery.call('recoveryEstimateCaseFees', {
      body: parseBody(requestBodies.recoveryEstimateCaseFees, body),
    });
  }

  @Route('recoveryListMyCases')
  listMyCases(@Query() query: QueryParams) {
    return this.recovery.call('recoveryListMyCases', {
      query: queryFrom(recoveryQueries.recoveryListMyCases, query),
    });
  }

  @Route('recoveryCreateCase')
  createCase(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryCreateCase', {
      body: parseBody(requestBodies.recoveryCreateCase, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryGetMyCase')
  getMyCase(@Param('id') id: unknown) {
    return this.recovery.call('recoveryGetMyCase', { params: { id: idFrom(id) } });
  }

  @Route('recoveryUpdateCase')
  updateCase(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryUpdateCase', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryUpdateCase, body),
    });
  }

  @Route('recoveryAddCaseDocument')
  addCaseDocument(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAddCaseDocument', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAddCaseDocument, body),
    });
  }

  @Route('recoveryPrepareMandate')
  prepareMandate(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryPrepareMandate', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryPrepareMandate, body),
    });
  }

  @Route('recoveryPayCaseFee')
  payCaseFee(@Param('id') id: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryPayCaseFee', {
      params: { id: idFrom(id) },
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryListMyCaseJournal')
  listMyCaseJournal(@Param('id') id: unknown, @Query() query: QueryParams) {
    return this.recovery.call('recoveryListMyCaseJournal', {
      params: { id: idFrom(id) },
      query: queryFrom(recoveryQueries.recoveryListMyCaseJournal, query),
    });
  }

  @Route('recoveryCreateCaseImport')
  createCaseImport(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryCreateCaseImport', {
      body: parseBody(requestBodies.recoveryCreateCaseImport, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryGetCaseImport')
  getCaseImport(@Param('id') id: unknown) {
    return this.recovery.call('recoveryGetCaseImport', { params: { id: idFrom(id) } });
  }

  @Route('recoveryUpdateCaseImportLine')
  updateCaseImportLine(@Param('id') id: unknown, @Param('row') row: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryUpdateCaseImportLine', {
      params: { id: idFrom(id), row: rowFrom(row) },
      body: parseBody(requestBodies.recoveryUpdateCaseImportLine, body),
    });
  }

  @Route('recoveryConfirmCaseImport')
  confirmCaseImport(@Param('id') id: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryConfirmCaseImport', {
      params: { id: idFrom(id) },
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryListMyDecisions')
  listMyDecisions(@Query() query: QueryParams) {
    return this.recovery.call('recoveryListMyDecisions', {
      query: queryFrom(recoveryQueries.recoveryListMyDecisions, query),
    });
  }

  @Route('recoveryAnswerDecision')
  answerDecision(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAnswerDecision', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAnswerDecision, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryStopCase')
  stopCase(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryStopCase', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryStopCase, body),
    });
  }

  @Route('recoveryDeclareDirectPayment')
  declareDirectPayment(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryDeclareDirectPayment', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryDeclareDirectPayment, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryListMyRemittances')
  listMyRemittances(@Query() query: QueryParams) {
    return this.recovery.call('recoveryListMyRemittances', {
      query: queryFrom(recoveryQueries.recoveryListMyRemittances, query),
    });
  }

  @Route('recoveryListMyStatements')
  listMyStatements(@Query() query: QueryParams) {
    return this.recovery.call('recoveryListMyStatements', {
      query: queryFrom(recoveryQueries.recoveryListMyStatements, query),
    });
  }

  @Route('recoveryGetMyDashboard')
  getMyDashboard() {
    return this.recovery.call('recoveryGetMyDashboard', {});
  }

  @Route('recoveryGetMyPreferences')
  getMyPreferences() {
    return this.recovery.call('recoveryGetMyPreferences', {});
  }

  @Route('recoveryUpdateMyPreferences')
  updateMyPreferences(@Body() body: unknown) {
    return this.recovery.call('recoveryUpdateMyPreferences', {
      body: parseBody(requestBodies.recoveryUpdateMyPreferences, body),
    });
  }

  // --- Débiteur sans compte (ADR-061) --------------------------------------------------------------

  @Route('recoveryOpenDebtorAccess')
  openDebtorAccess(@Param('token') token: unknown) {
    return this.recovery.call('recoveryOpenDebtorAccess', { params: { token: tokenFrom(token) } });
  }

  @Route('recoverySendDebtorAccessCode')
  sendDebtorAccessCode(@Param('token') token: unknown) {
    return this.recovery.call('recoverySendDebtorAccessCode', { params: { token: tokenFrom(token) } });
  }

  @Route('recoveryVerifyDebtorAccessCode')
  verifyDebtorAccessCode(@Param('token') token: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryVerifyDebtorAccessCode', {
      params: { token: tokenFrom(token) },
      body: parseBody(requestBodies.recoveryVerifyDebtorAccessCode, body),
    });
  }

  @Route('recoveryEndDebtorSession')
  endDebtorSession(@Headers('x-debtor-session') session: unknown) {
    return this.recovery.call('recoveryEndDebtorSession', { debtorSession: sessionFrom(session) });
  }

  @Route('recoveryGetDebtorCase')
  getDebtorCase(@Headers('x-debtor-session') session: unknown) {
    return this.recovery.call('recoveryGetDebtorCase', { debtorSession: sessionFrom(session) });
  }

  @Route('recoveryCreateDebtorPayment')
  createDebtorPayment(
    @Headers('x-debtor-session') session: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryCreateDebtorPayment', {
      debtorSession: sessionFrom(session),
      body: parseBody(requestBodies.recoveryCreateDebtorPayment, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoverySimulateDebtorPaymentPlan')
  simulateDebtorPaymentPlan(@Headers('x-debtor-session') session: unknown, @Body() body: unknown) {
    return this.recovery.call('recoverySimulateDebtorPaymentPlan', {
      debtorSession: sessionFrom(session),
      body: parseBody(requestBodies.recoverySimulateDebtorPaymentPlan, body),
    });
  }

  @Route('recoveryProposeDebtorPaymentPlan')
  proposeDebtorPaymentPlan(
    @Headers('x-debtor-session') session: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryProposeDebtorPaymentPlan', {
      debtorSession: sessionFrom(session),
      body: parseBody(requestBodies.recoveryProposeDebtorPaymentPlan, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryResendDebtorPlanSignature')
  resendDebtorPlanSignature(@Headers('x-debtor-session') session: unknown, @Param('id') id: unknown) {
    return this.recovery.call('recoveryResendDebtorPlanSignature', {
      debtorSession: sessionFrom(session),
      params: { id: idFrom(id) },
    });
  }

  @Route('recoveryDisputeDebtorCase')
  disputeDebtorCase(
    @Headers('x-debtor-session') session: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryDisputeDebtorCase', {
      debtorSession: sessionFrom(session),
      body: parseBody(requestBodies.recoveryDisputeDebtorCase, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryCreateDebtorUpload')
  createDebtorUpload(@Headers('x-debtor-session') session: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryCreateDebtorUpload', {
      debtorSession: sessionFrom(session),
      body: parseBody(requestBodies.recoveryCreateDebtorUpload, body),
    });
  }

  @Route('recoveryCompleteDebtorUpload')
  completeDebtorUpload(@Headers('x-debtor-session') session: unknown, @Param('id') id: unknown) {
    return this.recovery.call('recoveryCompleteDebtorUpload', {
      debtorSession: sessionFrom(session),
      params: { id: idFrom(id) },
    });
  }

  @Route('recoveryRequestDebtorCallback')
  requestDebtorCallback(@Headers('x-debtor-session') session: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryRequestDebtorCallback', {
      debtorSession: sessionFrom(session),
      body: parseBody(requestBodies.recoveryRequestDebtorCallback, body),
    });
  }

  @Route('recoveryGetDebtorDocumentUrl')
  getDebtorDocumentUrl(@Headers('x-debtor-session') session: unknown, @Param('id') id: unknown) {
    return this.recovery.call('recoveryGetDebtorDocumentUrl', {
      debtorSession: sessionFrom(session),
      params: { id: idFrom(id) },
    });
  }

  // --- Huissiers et avocats partenaires ------------------------------------------------------------

  @Route('recoveryListMyAssignments')
  listMyAssignments(@Query() query: QueryParams) {
    return this.recovery.call('recoveryListMyAssignments', {
      query: queryFrom(recoveryQueries.recoveryListMyAssignments, query),
    });
  }

  @Route('recoveryGetMyAssignment')
  getMyAssignment(@Param('id') id: unknown) {
    return this.recovery.call('recoveryGetMyAssignment', { params: { id: idFrom(id) } });
  }

  @Route('recoveryRecordLegalAct')
  recordLegalAct(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryRecordLegalAct', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryRecordLegalAct, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryDeclarePartnerCollection')
  declarePartnerCollection(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryDeclarePartnerCollection', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryDeclarePartnerCollection, body),
      idempotencyKey: keyFrom(key),
    });
  }
}
