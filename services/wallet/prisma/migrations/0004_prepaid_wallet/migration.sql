-- ADR-046 : portefeuille prépayé de chaque client, dans le même grand livre (ADR-042). Un second
-- compte par titulaire (« prepaid:<type>:<id> »), distinct du compte des fonds dus au créancier,
-- dépensable et jamais négatif ; deux comptes internes ; trois sortes d'écritures. Ajouts seulement :
-- les écritures existantes restent immuables (aucune ligne n'est modifiée).

-- Comptes : un compte « holder » et un compte « prepaid » par titulaire.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_kind_check";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_kind_check" CHECK (
  ("kind" = 'internal' AND "holder_type" IS NULL AND "holder_id" IS NULL)
  OR ("kind" IN ('holder', 'prepaid') AND "holder_type" IN ('user', 'organization') AND "holder_id" IS NOT NULL
      AND "code" = "kind" || ':' || "holder_type" || ':' || "holder_id"::text)
);
-- Un portefeuille prépayé n'est jamais négatif : contrôlé par l'application sous le verrou du compte,
-- puis par la base (le déclencheur qui tient le solde échoue sur cette contrainte).
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_prepaid_balance_check" CHECK (
  "kind" <> 'prepaid' OR "balance" >= 0
);

DROP INDEX "ledger_accounts_holder_type_holder_id_key";
CREATE UNIQUE INDEX "ledger_accounts_kind_holder_type_holder_id_key" ON "ledger_accounts"("kind", "holder_type", "holder_id");

-- Recharges reçues par Mobile Money (actif, sens débit) ; services payés depuis un portefeuille
-- (produit, sens crédit). Invariant : fonds des recharges = Σ portefeuilles + services payés.
INSERT INTO "ledger_accounts" ("code", "kind", "normal_side") VALUES
  ('ksp:prepaid_funds', 'internal', 'debit'),
  ('ksp:service_revenue', 'internal', 'credit');

-- Écritures : recharge, paiement d'un service, remboursement.
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK (
  "kind" IN ('collection', 'payout_hold', 'payout_settlement', 'payout_release', 'reversal',
             'top_up', 'service_payment', 'refund')
);

-- Auteur (client qui paie ou recharge, membre de la finance) et objet payé chez le service appelant.
ALTER TABLE "ledger_transactions"
  ADD COLUMN "actor_id" UUID,
  ADD COLUMN "object_type" TEXT,
  ADD COLUMN "object_id" UUID,
  ADD COLUMN "object_part" TEXT;
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_object_check" CHECK (
  ("object_type" IS NULL AND "object_id" IS NULL AND "object_part" IS NULL)
  OR ("object_type" IS NOT NULL AND "object_id" IS NOT NULL)
);
CREATE INDEX "ledger_transactions_object_type_object_id_idx" ON "ledger_transactions"("object_type", "object_id");
