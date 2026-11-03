-- Clé d'idempotence du paiement manuel d'une facture (en-tête Idempotency-Key, facultatif) : un même
-- envoi n'enregistre qu'un paiement par facture. Les paiements sans clé (NULL) ne sont pas concernés.

-- AlterTable
ALTER TABLE "invoice_payments" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payments_invoice_id_idempotency_key_key" ON "invoice_payments"("invoice_id", "idempotency_key");
