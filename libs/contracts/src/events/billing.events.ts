/**
 * Événements publiés par billing (facturation mensuelle des contrats d'entreprise, CDC
 * Nettoyage partie 10). Source de vérité : contracts/events/billing/*.schema.json. Identifiants
 * et montants seulement.
 */
export interface BillingMoney {
  amount: number;
  currency: 'XOF';
}

/** Service métier à l'origine du contrat facturé. */
export type BillingSource = 'cleaning';

interface InvoiceRef {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  organizationId: string | null;
  source: BillingSource;
  /** Contrat chez le service source (pour cleaning : la mission). */
  contractId: string;
  total: BillingMoney;
}

export interface BillingEventPayloads {
  'billing.invoice.issued': InvoiceRef & {
    periodStart: string;
    periodEnd: string;
    issuedAt: string;
    dueAt: string;
  };
  'billing.invoice.overdue': InvoiceRef & {
    dueAt: string;
    /** Factures impayées du contrat, celle-ci comprise. */
    overdueCount: number;
  };
  'billing.invoice.paid': InvoiceRef & {
    paidAt: string;
    /** Factures du contrat encore impayées après ce règlement. */
    overdueCount: number;
  };
}

export type BillingEventType = keyof BillingEventPayloads;
