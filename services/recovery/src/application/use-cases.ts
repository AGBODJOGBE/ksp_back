import {
  type AmicableOptions,
  type AmicableStore,
  createAmicableUseCases,
  type DocumentCancellation,
} from './amicable';
import { AmicableSettlementTerms } from './amicable/settlement-terms';
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
import { type DebtorUploads, type DocumentUrls } from './debtor-space/debtor-space.ports';
import { NO_SETTLEMENTS, type SettlementTerms } from './debtor-space/settlement-terms';
import {
  createLitigationUseCases,
  type EscalationDecisions,
  EscalationDecisionsService,
  type LitigationStore,
} from './litigation';
import { createMoneyUseCases } from './money';
import { CaseClosure } from './money/case-closure.service';
import { type MoneyStore } from './money/money.ports';
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
  // Procédure amiable (R4) : contacts, promesses, échéanciers, décisions, messages au débiteur.
  amicable: AmicableStore;
  documentCancellation: DocumentCancellation;
  amicableOptions: AmicableOptions;
  // Argent et espace du débiteur (R3) : encaissements, paiements hors ligne, contestations, pièces.
  money: MoneyStore;
  debtorUploads: DebtorUploads;
  documentUrls: DocumentUrls;
  // Contentieux (R5) : mises en demeure, devis et provisions, partenaires, assignations et actes.
  litigation: LitigationStore;
}

/**
 * Les dépendances, plus les remises (R-PR-05) : vue qui relit `deps` à chaque accès, sans copie, pour
 * suivre un port remplacé après la création (doublures des tests).
 */
function withSettlementTerms(
  deps: RecoveryDeps,
  settlementTerms: SettlementTerms,
): RecoveryDeps & { settlementTerms: SettlementTerms } {
  return Object.create(deps, {
    settlementTerms: { value: settlementTerms, enumerable: true },
  }) as RecoveryDeps & {
    settlementTerms: SettlementTerms;
  };
}

/** Les dépendances, plus les devis des étapes payantes (R5) pour les décisions de R4 (même vue). */
function withEscalations(
  deps: RecoveryDeps,
  escalations: EscalationDecisions,
): RecoveryDeps & { escalations: EscalationDecisions } {
  return Object.create(deps, {
    escalations: { value: escalations, enumerable: true },
  }) as RecoveryDeps & { escalations: EscalationDecisions };
}

export function createUseCases(deps: RecoveryDeps) {
  // Remises de R4 payées par le lien du débiteur (R3) : exécutées, puis dossier clos par le service
  // de clôture de R3 (« accord transactionnel exécuté »).
  const closure = new CaseClosure(withSettlementTerms(deps, NO_SETTLEMENTS));
  // Devis des étapes payantes (R5) : tranchés par AnswerDecision, expirés par la tâche de R4.
  const amicableDeps = withEscalations(
    deps,
    new EscalationDecisionsService(withSettlementTerms(deps, NO_SETTLEMENTS)),
  );
  const moneyDeps = withSettlementTerms(deps, new AmicableSettlementTerms(deps, closure));
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
    ...createAmicableUseCases(amicableDeps),
    ...createMoneyUseCases(moneyDeps),
    ...createLitigationUseCases(moneyDeps),
  };
}

export type RecoveryUseCases = ReturnType<typeof createUseCases>;
