-- ADR-049 : arrêt de la suite d'une mission récurrente par le client. Le montant payé pour des
-- passages non faits est crédité dans son portefeuille prépayé (cleaning.mission.credited, une seule
-- fois par credit_id) ; il ne compte plus dans le montant payé.
ALTER TABLE "missions" ADD COLUMN "credit_id" UUID;
ALTER TABLE "missions" ADD COLUMN "credited_amount" INTEGER;
ALTER TABLE "missions" ADD COLUMN "credited_at" TIMESTAMPTZ(3);
ALTER TABLE "missions" ADD CONSTRAINT "missions_credit_check" CHECK (
  ("credit_id" IS NULL AND "credited_amount" IS NULL AND "credited_at" IS NULL)
  OR ("credit_id" IS NOT NULL AND "credited_amount" > 0 AND "credited_at" IS NOT NULL)
);
