-- ADR-042 : grand livre en double entrée des fonds détenus par KSP pour ses clients.
-- Écritures immuables (aucune mise à jour ni suppression), transactions équilibrées (contrôle différé
-- à la validation), soldes tenus par la base à chaque écriture (jamais saisis), montants entiers XOF.

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holder_type" TEXT,
    "holder_id" UUID,
    "normal_side" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "ledger_accounts_kind_check" CHECK (
      ("kind" = 'internal' AND "holder_type" IS NULL AND "holder_id" IS NULL)
      OR ("kind" = 'holder' AND "holder_type" IN ('user', 'organization') AND "holder_id" IS NOT NULL
          AND "code" = 'holder:' || "holder_type" || ':' || "holder_id"::text)
    ),
    CONSTRAINT "ledger_accounts_normal_side_check" CHECK ("normal_side" IN ('debit', 'credit'))
);

CREATE UNIQUE INDEX "ledger_accounts_holder_type_holder_id_key" ON "ledger_accounts"("holder_type", "holder_id");

-- Comptes internes de KSP.
INSERT INTO "ledger_accounts" ("code", "kind", "normal_side") VALUES
  ('ksp:collections', 'internal', 'debit'),
  ('ksp:commission', 'internal', 'credit'),
  ('ksp:payouts_in_transit', 'internal', 'credit');

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "holder_type" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "gross_amount" BIGINT,
    "commission" BIGINT,
    "commission_rate_bps" INTEGER,
    "description" TEXT NOT NULL,
    "reverses_transaction_id" UUID,
    "payout_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_transactions_kind_check" CHECK (
      "kind" IN ('collection', 'payout_hold', 'payout_settlement', 'payout_release', 'reversal')
    ),
    CONSTRAINT "ledger_transactions_amount_check" CHECK ("amount" >= 0),
    CONSTRAINT "ledger_transactions_rate_check" CHECK (
      "commission_rate_bps" IS NULL OR "commission_rate_bps" BETWEEN 0 AND 10000
    ),
    CONSTRAINT "ledger_transactions_reverses_transaction_id_fkey" FOREIGN KEY ("reverses_transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ledger_transactions_caller_reference_key" ON "ledger_transactions"("caller", "reference");
-- Une seule annulation par transaction.
CREATE UNIQUE INDEX "ledger_transactions_reverses_transaction_id_key" ON "ledger_transactions"("reverses_transaction_id");
CREATE INDEX "ledger_transactions_holder_type_holder_id_idx" ON "ledger_transactions"("holder_type", "holder_id");

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_code" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    -- Solde du compte après l'écriture, calculé par la base (déclencheur ci-dessous).
    "balance_after" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_entries_direction_check" CHECK ("direction" IN ('debit', 'credit')),
    CONSTRAINT "ledger_entries_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_entries_account_code_fkey" FOREIGN KEY ("account_code")
      REFERENCES "ledger_accounts"("code") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ledger_entries_account_code_id_idx" ON "ledger_entries"("account_code", "id");
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- Solde tenu par la base : chaque écriture met à jour le solde de son compte (verrouillé) et note
-- le solde obtenu. Aucun autre chemin ne modifie un solde.
CREATE FUNCTION ledger_apply_entry() RETURNS trigger AS $$
DECLARE
  side TEXT;
BEGIN
  SELECT "normal_side" INTO side FROM "ledger_accounts" WHERE "code" = NEW."account_code" FOR UPDATE;
  IF side IS NULL THEN
    RAISE EXCEPTION 'Compte du grand livre inconnu : %', NEW."account_code";
  END IF;
  UPDATE "ledger_accounts"
     SET "balance" = "balance" + CASE WHEN NEW."direction" = side THEN NEW."amount" ELSE -NEW."amount" END
   WHERE "code" = NEW."account_code"
  RETURNING "balance" INTO NEW."balance_after";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_apply" BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();

-- Transaction équilibrée : vérifiée à la validation (débits = crédits, au moins deux lignes).
CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  debits BIGINT;
  credits BIGINT;
  lines INTEGER;
BEGIN
  SELECT COALESCE(SUM("amount") FILTER (WHERE "direction" = 'debit'), 0),
         COALESCE(SUM("amount") FILTER (WHERE "direction" = 'credit'), 0),
         COUNT(*)
    INTO debits, credits, lines
    FROM "ledger_entries" WHERE "transaction_id" = NEW."transaction_id";
  IF debits <> credits OR lines < 2 THEN
    RAISE EXCEPTION 'Transaction % déséquilibrée (débits %, crédits %)', NEW."transaction_id", debits, credits;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced" AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- Écritures immuables : une erreur se corrige par une écriture inverse.
CREATE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Le grand livre est immuable : % interdit sur %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_transactions_immutable" BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER "ledger_entries_immutable" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- CreateTable
CREATE TABLE "wallet_payouts" (
    "id" UUID NOT NULL,
    "caller" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "holder_type" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "beneficiary_phone" TEXT,
    "beneficiary_name" TEXT,
    "beneficiary_phone_masked" TEXT NOT NULL,
    "beneficiary_operator" TEXT NOT NULL,
    "payment_payout_id" TEXT,
    "hold_transaction_id" UUID NOT NULL,
    "settlement_transaction_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallet_payouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wallet_payouts_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "wallet_payouts_status_check" CHECK (
      "status" IN ('pending_submission', 'submitted', 'completed', 'failed')
    ),
    -- Le numéro complet n'est gardé que tant que le reversement n'est pas transmis à payment.
    CONSTRAINT "wallet_payouts_phone_check" CHECK ("status" = 'pending_submission' OR "beneficiary_phone" IS NULL),
    CONSTRAINT "wallet_payouts_hold_transaction_id_fkey" FOREIGN KEY ("hold_transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "wallet_payouts_settlement_transaction_id_fkey" FOREIGN KEY ("settlement_transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "wallet_payouts_caller_idempotency_key_key" ON "wallet_payouts"("caller", "idempotency_key");
CREATE INDEX "wallet_payouts_holder_type_holder_id_id_idx" ON "wallet_payouts"("holder_type", "holder_id", "id");
CREATE INDEX "wallet_payouts_status_created_at_idx" ON "wallet_payouts"("status", "created_at");
