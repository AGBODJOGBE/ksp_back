import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { type RecoveryApi } from '../../application/recovery/recovery.ports';
import { RECOVERY_API } from '../../tokens';
import { idFrom, keyFrom, queryFrom, yearFrom, type QueryParams } from './recovery-params';
import { recoveryQueries } from './recovery-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes /api/v1/admin/recovery/* (ADR-060, ADR-062) : recevabilité, traitement des dossiers,
 * courriers, partenaires, paiements hors ligne, clôture, tarification et réglages. Rôles et double
 * authentification contrôlés par la garde d'après le manifeste ; périmètre revérifié par recovery.
 */
@Controller()
export class RecoveryAdminHttpController {
  constructor(@Inject(RECOVERY_API) private readonly recovery: RecoveryApi) {}

  @Route('recoveryAdminOverview')
  overview(@Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminOverview', {
      query: queryFrom(recoveryQueries.recoveryAdminOverview, query),
    });
  }

  @Route('recoveryAdminWorkQueue')
  workQueue(@Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminWorkQueue', {
      query: queryFrom(recoveryQueries.recoveryAdminWorkQueue, query),
    });
  }

  @Route('recoveryAdminListCases')
  listCases(@Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminListCases', {
      query: queryFrom(recoveryQueries.recoveryAdminListCases, query),
    });
  }

  @Route('recoveryAdminGetCase')
  getCase(@Param('id') id: unknown) {
    return this.recovery.call('recoveryAdminGetCase', { params: { id: idFrom(id) } });
  }

  @Route('recoveryAdminListCaseJournal')
  listCaseJournal(@Param('id') id: unknown, @Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminListCaseJournal', {
      params: { id: idFrom(id) },
      query: queryFrom(recoveryQueries.recoveryAdminListCaseJournal, query),
    });
  }

  @Route('recoveryAdminAssessCase')
  assessCase(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAdminAssessCase', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminAssessCase, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminAssignCase')
  assignCase(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminAssignCase', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminAssignCase, body),
    });
  }

  @Route('recoveryAdminRecordContact')
  recordContact(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAdminRecordContact', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminRecordContact, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminRecordPromise')
  recordPromise(@Param('id') id: unknown, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAdminRecordPromise', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminRecordPromise, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminSendDebtorMessage')
  sendDebtorMessage(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminSendDebtorMessage', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminSendDebtorMessage, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminAddNote')
  addNote(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminAddNote', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminAddNote, body),
    });
  }

  @Route('recoveryAdminProposePaymentPlan')
  proposePaymentPlan(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminProposePaymentPlan', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminProposePaymentPlan, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminApprovePaymentPlan')
  approvePaymentPlan(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminApprovePaymentPlan', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminApprovePaymentPlan, body),
    });
  }

  @Route('recoveryAdminProposeSettlement')
  proposeSettlement(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminProposeSettlement', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminProposeSettlement, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminChangeStage')
  changeStage(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminChangeStage', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminChangeStage, body),
    });
  }

  @Route('recoveryAdminIssueFormalNotice')
  issueFormalNotice(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminIssueFormalNotice', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminIssueFormalNotice, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminRecordNoticeDelivery')
  recordNoticeDelivery(@Param('id') id: unknown, @Param('notice') notice: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminRecordNoticeDelivery', {
      params: { id: idFrom(id), notice: idFrom(notice) },
      body: parseBody(requestBodies.recoveryAdminRecordNoticeDelivery, body),
    });
  }

  @Route('recoveryAdminResolveDispute')
  resolveDispute(@Param('id') id: unknown, @Param('dispute') dispute: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminResolveDispute', {
      params: { id: idFrom(id), dispute: idFrom(dispute) },
      body: parseBody(requestBodies.recoveryAdminResolveDispute, body),
    });
  }

  @Route('recoveryAdminRequestEscalation')
  requestEscalation(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminRequestEscalation', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminRequestEscalation, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminSuggestPartners')
  suggestPartners(@Param('id') id: unknown, @Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminSuggestPartners', {
      params: { id: idFrom(id) },
      query: queryFrom(recoveryQueries.recoveryAdminSuggestPartners, query),
    });
  }

  @Route('recoveryAdminAssignPartner')
  assignPartner(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminAssignPartner', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminAssignPartner, body),
    });
  }

  @Route('recoveryAdminWithdrawPartner')
  withdrawPartner(@Param('id') id: unknown, @Param('assignment') assignment: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminWithdrawPartner', {
      params: { id: idFrom(id), assignment: idFrom(assignment) },
      body: parseBody(requestBodies.recoveryAdminWithdrawPartner, body),
    });
  }

  @Route('recoveryAdminRecordOfflinePayment')
  recordOfflinePayment(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminRecordOfflinePayment', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminRecordOfflinePayment, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminListOfflinePayments')
  listOfflinePayments(@Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminListOfflinePayments', {
      query: queryFrom(recoveryQueries.recoveryAdminListOfflinePayments, query),
    });
  }

  @Route('recoveryAdminApproveOfflinePayment')
  approveOfflinePayment(@Param('id') id: unknown) {
    return this.recovery.call('recoveryAdminApproveOfflinePayment', { params: { id: idFrom(id) } });
  }

  @Route('recoveryAdminRejectOfflinePayment')
  rejectOfflinePayment(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminRejectOfflinePayment', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminRejectOfflinePayment, body),
    });
  }

  @Route('recoveryAdminRecordOverpaymentRefund')
  recordOverpaymentRefund(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.recovery.call('recoveryAdminRecordOverpaymentRefund', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminRecordOverpaymentRefund, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminCloseCase')
  closeCase(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminCloseCase', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminCloseCase, body),
    });
  }

  @Route('recoveryAdminExportCaseJournal')
  exportCaseJournal(@Param('id') id: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAdminExportCaseJournal', {
      params: { id: idFrom(id) },
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminListPartners')
  listPartners(@Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminListPartners', {
      query: queryFrom(recoveryQueries.recoveryAdminListPartners, query),
    });
  }

  @Route('recoveryAdminCreatePartner')
  createPartner(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAdminCreatePartner', {
      body: parseBody(requestBodies.recoveryAdminCreatePartner, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminGetPartner')
  getPartner(@Param('id') id: unknown) {
    return this.recovery.call('recoveryAdminGetPartner', { params: { id: idFrom(id) } });
  }

  @Route('recoveryAdminUpdatePartner')
  updatePartner(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminUpdatePartner', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminUpdatePartner, body),
    });
  }

  @Route('recoveryAdminListPricingRules')
  listPricingRules(@Query() query: QueryParams) {
    return this.recovery.call('recoveryAdminListPricingRules', {
      query: queryFrom(recoveryQueries.recoveryAdminListPricingRules, query),
    });
  }

  @Route('recoveryAdminCreatePricingRule')
  createPricingRule(@Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    return this.recovery.call('recoveryAdminCreatePricingRule', {
      body: parseBody(requestBodies.recoveryAdminCreatePricingRule, body),
      idempotencyKey: keyFrom(key),
    });
  }

  @Route('recoveryAdminGetPricingRule')
  getPricingRule(@Param('id') id: unknown) {
    return this.recovery.call('recoveryAdminGetPricingRule', { params: { id: idFrom(id) } });
  }

  @Route('recoveryAdminUpdatePricingRule')
  updatePricingRule(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminUpdatePricingRule', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminUpdatePricingRule, body),
    });
  }

  @Route('recoveryAdminPublishPricingRule')
  publishPricingRule(@Param('id') id: unknown) {
    return this.recovery.call('recoveryAdminPublishPricingRule', { params: { id: idFrom(id) } });
  }

  @Route('recoveryAdminApprovePricingRule')
  approvePricingRule(@Param('id') id: unknown) {
    return this.recovery.call('recoveryAdminApprovePricingRule', { params: { id: idFrom(id) } });
  }

  @Route('recoveryAdminArchivePricingRule')
  archivePricingRule(@Param('id') id: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminArchivePricingRule', {
      params: { id: idFrom(id) },
      body: parseBody(requestBodies.recoveryAdminArchivePricingRule, body),
    });
  }

  @Route('recoveryAdminSimulatePricing')
  simulatePricing(@Body() body: unknown) {
    return this.recovery.call('recoveryAdminSimulatePricing', {
      body: parseBody(requestBodies.recoveryAdminSimulatePricing, body),
    });
  }

  @Route('recoveryAdminGetSettings')
  getSettings() {
    return this.recovery.call('recoveryAdminGetSettings', {});
  }

  @Route('recoveryAdminUpdateSettings')
  updateSettings(@Body() body: unknown) {
    return this.recovery.call('recoveryAdminUpdateSettings', {
      body: parseBody(requestBodies.recoveryAdminUpdateSettings, body),
    });
  }

  @Route('recoveryAdminListHolidays')
  listHolidays(@Param('year') year: unknown) {
    return this.recovery.call('recoveryAdminListHolidays', { params: { year: yearFrom(year) } });
  }

  @Route('recoveryAdminSetHolidays')
  setHolidays(@Param('year') year: unknown, @Body() body: unknown) {
    return this.recovery.call('recoveryAdminSetHolidays', {
      params: { year: yearFrom(year) },
      body: parseBody(requestBodies.recoveryAdminSetHolidays, body),
    });
  }
}
