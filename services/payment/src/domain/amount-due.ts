/**
 * Montants dus, tels que le service qui porte l'objet payé les calcule (billing) : payment n'en
 * recalcule aucun (ADR-031). Il ne fait que vérifier que le payeur est dans le périmètre de l'objet.
 * L'acompte et le solde d'une mission du Nettoyage v1 (lus dans cleaning) sont retirés avec la v1
 * (ADR-054) : le Nettoyage v2 passe par le portefeuille et le paiement direct (ADR-055).
 */
export interface InvoiceDue {
  invoiceId: string;
  number: string;
  customerId: string;
  organizationId: string | null;
  status: string;
  balance: number;
  /** Paiements en ligne (identifiants payment) déjà enregistrés sur la facture par billing. */
  recordedPaymentIds: string[];
}

/** Paiement réussi d'un objet, et l'instant de sa réussite. */
export interface SucceededPayment {
  id: string;
  succeededAt: Date;
}

/** Paiements réussis pas encore enregistrés, et la plus ancienne de leurs réussites. */
export interface UnrecordedSuccesses {
  paymentIds: string[];
  since: Date;
}

/**
 * Paiements réussis que le service de l'objet n'a pas encore enregistrés (événement en route, relais
 * en retard) : leur montant n'est pas encore déduit du montant dû. Tant qu'il en existe un, un
 * nouveau paiement ferait payer deux fois (ADR-032). null s'il n'y en a aucun.
 */
export function unrecordedSuccesses(
  succeeded: readonly SucceededPayment[],
  recordedIds: readonly string[],
): UnrecordedSuccesses | null {
  const recorded = new Set(recordedIds);
  const pending = succeeded.filter((payment) => !recorded.has(payment.id));
  if (pending.length === 0) return null;
  const since = Math.min(...pending.map((payment) => payment.succeededAt.getTime()));
  return { paymentIds: pending.map((payment) => payment.id), since: new Date(since) };
}

/** Périmètre du payeur : son organisation active, sinon lui-même (contexte personnel). */
export interface PayerScope {
  userId: string;
  organizationId: string | null;
}

export type DueRefusal = 'not_found' | 'not_payable' | 'nothing_due';

/**
 * Montant à payer pour une facture, ou la raison du refus. Même périmètre que « Mes factures » :
 * celles de l'organisation active, ou les factures personnelles du client.
 */
export function invoiceAmount(
  due: InvoiceDue,
  payer: PayerScope,
): { amount: number } | { refusal: DueRefusal } {
  const visible = payer.organizationId
    ? due.organizationId === payer.organizationId
    : due.customerId === payer.userId && due.organizationId === null;
  if (!visible) return { refusal: 'not_found' };
  if (due.status === 'cancelled') return { refusal: 'not_payable' };
  if (due.status === 'paid' || due.balance <= 0) return { refusal: 'nothing_due' };
  return { amount: due.balance };
}
