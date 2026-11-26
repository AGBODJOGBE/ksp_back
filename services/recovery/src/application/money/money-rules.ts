import { AppError, tryNormalizePhone } from '@ksp/platform';
import { type CaseAmounts } from '../../domain/amounts';
import { type CaseStage } from '../../domain/case';
import { type DebtorAccessPorts } from '../debtor-access/debtor-access.ports';
import { type AdminCaseDeps } from '../cases/admin-cases.use-cases';
import { priorPayments } from '../cases/case-rules';
import { type DebtorData, type RecoveryCaseRecord } from '../cases/ports';
import { type DebtorChannel, type Notifier, type PaymentLinks, type PersonalData } from '../ports';
import { formatXof } from '../shared/errors';
import { type DebtorUploads, type DocumentUrls } from '../debtor-space/debtor-space.ports';
import { type DisputeResponses } from '../debtor-space/dispute-responses';
import { type SettlementTerms } from '../debtor-space/settlement-terms';
import { type CaseMoney, type MoneyStore } from './money.ports';

/**
 * Dépendances de l'argent et de l'espace du débiteur (lot R3) : celles du back-office des dossiers,
 * plus le dépôt de l'argent, les liens de paiement, les messages au débiteur, ses liens personnels,
 * ses pièces et les adresses de lecture des documents.
 */
export interface MoneyDeps extends AdminCaseDeps {
  money: MoneyStore;
  paymentLinks: PaymentLinks;
  notifier: Notifier;
  personalData: PersonalData;
  debtorAccess: DebtorAccessPorts;
  debtorUploads: DebtorUploads;
  documentUrls: DocumentUrls;
  /** Remises pour paiement immédiat (R4) ; `NO_SETTLEMENTS` en attendant. */
  settlementTerms: SettlementTerms;
  /** Réponse du créancier aux contestations (décision `dispute_response` de R4). */
  disputeResponses: DisputeResponses;
}

/** Erreurs de l'argent (en-tête de recovery.proto). */
export const MoneyErrors = {
  amountInvalid: (due: number, message?: string) =>
    AppError.precondition(
      'RECOVERY_PAYMENT_AMOUNT_INVALID',
      message ?? `Le montant doit être compris entre 1 FCFA et le montant dû (${formatXof(due)}).`,
      { due: { amount: due, currency: 'XOF' } },
    ),
  caseSuspended: () =>
    AppError.precondition(
      'RECOVERY_CASE_SUSPENDED',
      'Ce dossier est suspendu par une contestation : cette action attend la décision du juriste.',
    ),
  offlinePaymentNotFound: () =>
    AppError.notFound('RECOVERY_OFFLINE_PAYMENT_NOT_FOUND', 'Ce paiement hors ligne est introuvable.'),
  paymentInFlight: () =>
    AppError.precondition(
      'RECOVERY_INVALID_TRANSITION',
      'Un paiement vient d’être reçu sur le lien précédent : rechargez votre situation puis réessayez.',
      { status: 'active' },
    ),
} as const;

/**
 * Montants du dossier par composante, pour imputer un paiement (R-EN-03) : les paiements reçus avant
 * l'envoi ont été imputés aux intérêts puis au principal (`openingAmounts`), les encaissements depuis
 * selon leur imputation enregistrée.
 */
export function caseAmounts(record: RecoveryCaseRecord, money: CaseMoney): CaseAmounts {
  const prior = priorPayments(record);
  const priorInterests = Math.min(prior, record.interests);
  return {
    costs: { owed: record.costs, paid: Math.min(record.costs, money.collected.costs) },
    interests: {
      owed: record.interests,
      paid: Math.min(record.interests, priorInterests + money.collected.interests),
    },
    principal: {
      owed: record.principal,
      paid: Math.min(record.principal, prior - priorInterests + money.collected.principal),
    },
  };
}

/** Trop-perçu encore à rembourser au débiteur (ADR-060, point 9). */
export function overpaidBalance(money: CaseMoney): number {
  return Math.max(0, money.overpaid - money.refunded);
}

/** Étape d'un encaissement (contrat) : l'étape en cours, sinon la plus avancée atteinte. */
export function collectionStage(record: RecoveryCaseRecord): CaseStage {
  return record.stage ?? record.highestStage ?? 'notice';
}

/** Débiteur principal du dossier (le premier, sinon). */
export function mainDebtor(record: RecoveryCaseRecord): DebtorData | null {
  return record.debtors.find((debtor) => debtor.role === 'main') ?? record.debtors[0] ?? null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

/**
 * Destinataire d'un message direct au débiteur (ADR-061) : son téléphone principal valable par
 * WhatsApp, sinon son e-mail ; null s'il n'a aucune coordonnée utilisable.
 */
export function debtorRecipient(
  debtor: DebtorData | null,
): { channel: DebtorChannel; phone: string | null; email: string | null } | null {
  if (!debtor) return null;
  const valid = debtor.contacts.filter((contact) => contact.valid);
  const ordered = [...valid.filter((c) => c.isPrimary), ...valid.filter((c) => !c.isPrimary)];
  const phone =
    ordered
      .filter((contact) => contact.channel === 'phone')
      .map((contact) => tryNormalizePhone(contact.value))
      .find((value): value is string => Boolean(value)) ?? null;
  const email =
    ordered
      .filter((contact) => contact.channel === 'email')
      .map((contact) => contact.value.trim().toLowerCase())
      .find((value) => EMAIL.test(value)) ?? null;
  if (!phone && !email) return null;
  return { channel: phone ? 'whatsapp' : 'email', phone, email };
}

/** Jour « AAAA-MM-JJ » saisi, au plus aujourd'hui (heure du Bénin). */
export const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Texte libre facultatif : rogné, vide → null, `max` caractères au plus. */
export function optionalText(field: string, value: string | undefined, max: number): string | null {
  const text = value?.trim() ?? '';
  if (text.length > max) {
    throw AppError.invalid('RECOVERY_VALIDATION_FAILED', `${max} caractères au plus.`, { field });
  }
  return text || null;
}
