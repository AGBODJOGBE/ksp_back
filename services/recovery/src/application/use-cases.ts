import { type DebtorAccessPorts } from './debtor-access/debtor-access.ports';
import {
  EndDebtorSessionUseCase,
  OpenDebtorAccessUseCase,
  ResolveDebtorSessionUseCase,
  SendDebtorAccessCodeUseCase,
  VerifyDebtorAccessCodeUseCase,
} from './debtor-access/debtor-access.use-cases';
import { createCaseUseCases } from './cases';
import {
  type CaseImportRepository,
  type CaseQueries,
  type CaseRepository,
  type CreditorPreferencesStore,
  type CreditorProfiles,
  type SpreadsheetReader,
} from './cases/ports';
import { HasPendingObligationsUseCase } from './obligations.use-cases';
import {
  type AuditLog,
  type CaseObligations,
  type Clock,
  type Directory,
  type Documents,
  type Files,
  type HolidayStore,
  type IdGenerator,
  type Notifier,
  type PaymentLinks,
  type PersonalData,
  type PricingRuleStore,
  type SettingsStore,
  type WalletGateway,
} from './ports';
import {
  ApprovePricingRuleUseCase,
  ArchivePricingRuleUseCase,
  CreatePricingRuleUseCase,
  EstimateCaseFeesUseCase,
  GetPricingRuleUseCase,
  ListPricingRulesUseCase,
  PublishPricingRuleUseCase,
  SimulatePricingUseCase,
  UpdatePricingRuleUseCase,
} from './pricing.use-cases';
import {
  GetSettingsUseCase,
  ListHolidaysUseCase,
  SetHolidaysUseCase,
  UpdateSettingsUseCase,
} from './settings.use-cases';

/** Jeton d'injection des cas d'usage (racine de composition : app.module.ts). */
export const RECOVERY_USE_CASES = Symbol('RECOVERY_USE_CASES');

/**
 * Dépendances des cas d'usage (ADR-060). Les services appelés (wallet, payment, document, file,
 * notification, identity) et le chiffrement des données personnelles sont branchés dès R1 : les cas
 * d'usage des dossiers (R2 à R5) s'en servent.
 */
export interface RecoveryDeps {
  settings: SettingsStore;
  holidays: HolidayStore;
  rules: PricingRuleStore;
  audit: AuditLog;
  obligations: CaseObligations;
  personalData: PersonalData;
  wallet: WalletGateway;
  paymentLinks: PaymentLinks;
  documents: Documents;
  files: Files;
  notifier: Notifier;
  directory: Directory;
  clock: Clock;
  ids: IdGenerator;
  /** Lien, code et session du débiteur sans compte (ADR-061). */
  debtorAccess: DebtorAccessPorts;
  // Dossiers (R2) : dépôt, lectures, imports, préférences, identité du créancier, tableurs.
  cases: CaseRepository;
  caseQueries: CaseQueries;
  imports: CaseImportRepository;
  preferences: CreditorPreferencesStore;
  creditorProfiles: CreditorProfiles;
  spreadsheets: SpreadsheetReader;
}

export function createUseCases(deps: RecoveryDeps) {
  return {
    getSettings: new GetSettingsUseCase(deps),
    updateSettings: new UpdateSettingsUseCase(deps),
    listHolidays: new ListHolidaysUseCase(deps),
    setHolidays: new SetHolidaysUseCase(deps),
    listPricingRules: new ListPricingRulesUseCase(deps),
    getPricingRule: new GetPricingRuleUseCase(deps),
    createPricingRule: new CreatePricingRuleUseCase(deps),
    updatePricingRule: new UpdatePricingRuleUseCase(deps),
    publishPricingRule: new PublishPricingRuleUseCase(deps),
    approvePricingRule: new ApprovePricingRuleUseCase(deps),
    archivePricingRule: new ArchivePricingRuleUseCase(deps),
    simulatePricing: new SimulatePricingUseCase(deps),
    estimateCaseFees: new EstimateCaseFeesUseCase(deps),
    hasPendingObligations: new HasPendingObligationsUseCase({ cases: deps.obligations }),
    // Accès du débiteur (ADR-061). Les liens s'émettent par DebtorLinks, depuis les cas d'usage
    // qui écrivent au débiteur ; resolveDebtorSession sert à toutes les méthodes de la session.
    openDebtorAccess: new OpenDebtorAccessUseCase(deps),
    sendDebtorAccessCode: new SendDebtorAccessCodeUseCase(deps),
    verifyDebtorAccessCode: new VerifyDebtorAccessCodeUseCase(deps),
    endDebtorSession: new EndDebtorSessionUseCase(deps),
    resolveDebtorSession: new ResolveDebtorSessionUseCase(deps),
    ...createCaseUseCases(deps),
  };
}

export type RecoveryUseCases = ReturnType<typeof createUseCases>;
