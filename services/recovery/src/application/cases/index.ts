import {
  type AdminCaseDeps,
  AssessCaseUseCase,
  AssignCaseUseCase,
  GetCaseUseCase,
  GetRecoveryOverviewUseCase,
  ListCaseJournalUseCase,
  ListCasesUseCase,
} from './admin-cases.use-cases';
import { RecordMandateSignatureUseCase, WatchCaseDeadlinesUseCase } from './case-deadlines.use-cases';
import {
  ConfirmCaseImportUseCase,
  CreateCaseImportUseCase,
  GetCaseImportUseCase,
  UpdateCaseImportLineUseCase,
} from './case-imports.use-cases';
import {
  AddCaseDocumentUseCase,
  CreateCaseUseCase,
  GetMyCaseUseCase,
  GetMyDashboardUseCase,
  ListMyCaseJournalUseCase,
  ListMyCasesUseCase,
  PayCaseFeeUseCase,
  PrepareMandateUseCase,
  UpdateCaseUseCase,
} from './creditor-cases.use-cases';
import { GetMyPreferencesUseCase, UpdateMyPreferencesUseCase } from './creditor-preferences.use-cases';

/** Cas d'usage des dossiers (lot R2) : espace du créancier, recevabilité, tâches et événements. */
export function createCaseUseCases(deps: AdminCaseDeps) {
  return {
    createCase: new CreateCaseUseCase(deps),
    updateCase: new UpdateCaseUseCase(deps),
    addCaseDocument: new AddCaseDocumentUseCase(deps),
    prepareMandate: new PrepareMandateUseCase(deps),
    payCaseFee: new PayCaseFeeUseCase(deps),
    listMyCases: new ListMyCasesUseCase(deps),
    getMyCase: new GetMyCaseUseCase(deps),
    listMyCaseJournal: new ListMyCaseJournalUseCase(deps),
    getMyDashboard: new GetMyDashboardUseCase(deps),
    createCaseImport: new CreateCaseImportUseCase(deps),
    getCaseImport: new GetCaseImportUseCase(deps),
    updateCaseImportLine: new UpdateCaseImportLineUseCase(deps),
    confirmCaseImport: new ConfirmCaseImportUseCase(deps),
    getMyPreferences: new GetMyPreferencesUseCase(deps),
    updateMyPreferences: new UpdateMyPreferencesUseCase(deps),
    getRecoveryOverview: new GetRecoveryOverviewUseCase(deps),
    listCases: new ListCasesUseCase(deps),
    getCase: new GetCaseUseCase(deps),
    listCaseJournal: new ListCaseJournalUseCase(deps),
    assessCase: new AssessCaseUseCase(deps),
    assignCase: new AssignCaseUseCase(deps),
    watchCaseDeadlines: new WatchCaseDeadlinesUseCase(deps),
    recordMandateSignature: new RecordMandateSignatureUseCase(deps),
  };
}

export type { AdminCaseDeps } from './admin-cases.use-cases';
