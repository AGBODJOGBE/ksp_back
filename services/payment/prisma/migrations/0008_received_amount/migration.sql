-- ADR-048 : montant approuvé par le prestataire en XOF (réussite, ou écart de montant en XOF), lu par
-- wallet avant de créditer une recharge. Paiements réussis existants : leur montant.
ALTER TABLE "payment_intents" ADD COLUMN "received_amount" INTEGER;
UPDATE "payment_intents" SET "received_amount" = "amount" WHERE "status" = 'succeeded';
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_received_amount_check"
  CHECK ("received_amount" IS NULL OR "received_amount" > 0);
