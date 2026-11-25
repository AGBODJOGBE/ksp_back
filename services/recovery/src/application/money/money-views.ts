import { loadSettings } from '../settings.use-cases';
import { caseView, type CaseView, displayNames } from '../cases/case-views';
import { type RecoveryCaseRecord } from '../cases/ports';
import {
  type ClosureRecord,
  type CollectionRecord,
  type DisputeRecord,
  type OfflinePaymentRecord,
} from './money.ports';
import { type MoneyDeps, overpaidBalance } from './money-rules';

/**
 * Vues de l'argent : la fiche du dossier (R2) complétée de ses encaissements, contestations, clôture
 * et trop-perçu à rembourser ; les paiements hors ligne avec les noms affichés de leurs auteurs.
 */
export interface MoneyCaseView {
  view: CaseView;
  collections: CollectionRecord[];
  disputes: DisputeRecord[];
  closure: ClosureRecord | null;
  closedByName: string;
}

export async function moneyCaseView(
  deps: MoneyDeps,
  record: RecoveryCaseRecord,
  now: Date,
): Promise<MoneyCaseView> {
  const { settings } = await loadSettings(deps.settings);
  return withMoney(deps, await caseView(deps, record, settings, now));
}

/**
 * Fiche d'un dossier déjà lue et autorisée (GetCase, GetMyCase) complétée de son argent :
 * encaissements, contestations, clôture, trop-perçu à rembourser.
 */
export async function withMoney(
  deps: Pick<MoneyDeps, 'money' | 'directory'>,
  view: CaseView,
): Promise<MoneyCaseView> {
  const caseId = view.record.id;
  const [money, collections, disputes] = await Promise.all([
    deps.money.money(caseId),
    deps.money.collections(caseId),
    deps.money.disputes(caseId),
  ]);
  const closedBy = money.closure?.closedBy;
  const names =
    closedBy && (closedBy.type === 'agent' || closedBy.type === 'creditor') && closedBy.id
      ? await displayNames(deps.directory, [], [closedBy.id])
      : null;
  return {
    view: { ...view, amounts: { ...view.amounts, overpaid: overpaidBalance(money) } },
    collections,
    disputes,
    closure: money.closure,
    closedByName: names && closedBy?.id ? names.user(closedBy.id) : '',
  };
}

export interface OfflinePaymentView {
  payment: OfflinePaymentRecord;
  caseNumber: string;
  recordedByName: string;
  reviewedByName: string;
}

export async function offlinePaymentViews(
  deps: Pick<MoneyDeps, 'directory'>,
  items: readonly (OfflinePaymentRecord & { caseNumber: string })[],
): Promise<OfflinePaymentView[]> {
  if (items.length === 0) return [];
  const people = items.flatMap((item) => [item.recordedBy, ...(item.reviewedBy ? [item.reviewedBy] : [])]);
  const names = await displayNames(deps.directory, [], people);
  return items.map(({ caseNumber, ...payment }) => ({
    payment,
    caseNumber,
    recordedByName: names.user(payment.recordedBy),
    reviewedByName: names.user(payment.reviewedBy),
  }));
}
