-- ADR-048 : grand livre verrouillé comme le prévoit l'ADR-042. Ajouts seulement, aucune ligne modifiée.
--
-- Rôle applicatif (à appliquer par le déploiement, hors migration : le rôle dépend de l'environnement) :
--   REVOKE UPDATE, DELETE, TRUNCATE ON ledger_transactions, ledger_entries FROM <rôle de wallet>;
--   REVOKE DELETE, TRUNCATE ON ledger_accounts FROM <rôle de wallet>;
-- Les déclencheurs ci-dessous refusent les mêmes opérations même si ce retrait est oublié.

-- 1. Solde d'un compte : modifié seulement par le déclencheur des lignes (ledger_apply_entry), jamais
--    par une requête directe ; les autres colonnes d'un compte ne changent jamais ; aucun compte n'est
--    supprimé. pg_trigger_depth() vaut 1 pour une requête directe, 2 depuis ledger_apply_entry.
CREATE FUNCTION ledger_account_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Le grand livre est immuable : DELETE interdit sur ledger_accounts';
  END IF;
  IF NEW."code" IS DISTINCT FROM OLD."code" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."holder_type" IS DISTINCT FROM OLD."holder_type" OR NEW."holder_id" IS DISTINCT FROM OLD."holder_id"
     OR NEW."normal_side" IS DISTINCT FROM OLD."normal_side" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'Compte du grand livre immuable : %', OLD."code";
  END IF;
  IF NEW."balance" IS DISTINCT FROM OLD."balance" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Solde du compte % modifiable seulement par une écriture', OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_accounts_guard" BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION ledger_account_guard();

-- 2. TRUNCATE (qui ne déclenche pas les contrôles par ligne) refusé sur les trois tables.
CREATE FUNCTION ledger_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Le grand livre est immuable : TRUNCATE interdit sur %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_accounts_no_truncate" BEFORE TRUNCATE ON "ledger_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER "ledger_transactions_no_truncate" BEFORE TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();

-- 3. Transaction complète, vérifiée à la validation : au moins deux lignes, équilibrée, montant
--    strictement positif (brut d'un encaissement, sinon montant), débits égaux à ce montant, et
--    brut = net + commission pour un encaissement et son annulation.
CREATE FUNCTION ledger_check_transaction() RETURNS trigger AS $$
DECLARE
  debits BIGINT;
  credits BIGINT;
  lines INTEGER;
  expected BIGINT;
BEGIN
  SELECT COALESCE(SUM("amount") FILTER (WHERE "direction" = 'debit'), 0),
         COALESCE(SUM("amount") FILTER (WHERE "direction" = 'credit'), 0),
         COUNT(*)
    INTO debits, credits, lines
    FROM "ledger_entries" WHERE "transaction_id" = NEW."id";
  expected := COALESCE(NEW."gross_amount", NEW."amount");
  IF lines < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'Transaction % sans lignes ou déséquilibrée (débits %, crédits %)', NEW."id", debits, credits;
  END IF;
  IF expected <= 0 OR debits <> expected THEN
    RAISE EXCEPTION 'Transaction % : montant % incohérent avec ses lignes (débits %)', NEW."id", expected, debits;
  END IF;
  IF NEW."gross_amount" IS NOT NULL AND NEW."gross_amount" <> NEW."amount" + COALESCE(NEW."commission", 0) THEN
    RAISE EXCEPTION 'Transaction % : brut différent du net plus la commission', NEW."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_transactions_complete" AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction();

-- 4. Nom du bénéficiaire, comme son numéro : gardé seulement jusqu'à la transmission à payment.
ALTER TABLE "wallet_payouts" ADD CONSTRAINT "wallet_payouts_name_check"
  CHECK ("status" = 'pending_submission' OR "beneficiary_name" IS NULL);
