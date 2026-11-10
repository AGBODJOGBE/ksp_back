-- ADR-050 : confiance des signatures.

-- Essais de code pris pour une demande, tous codes confondus : au-delà du plafond, la demande est
-- close. Le compteur est pris sous le verrou de la demande, avant de comparer le code.
ALTER TABLE "signature_requests" ADD COLUMN "code_attempts" INTEGER NOT NULL DEFAULT 0;

-- La preuve de signature est immuable : aucune suppression, et une seule modification permise,
-- l'effacement de l'identifiant du signataire quand son compte est supprimé (ADR-036).
CREATE FUNCTION "signature_evidence_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."signer_user_id" IS NULL
     AND (to_jsonb(NEW) - 'signer_user_id') = (to_jsonb(OLD) - 'signer_user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'La preuve de signature est immuable (seul signer_user_id peut être effacé).'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "signature_evidence_immutable"
BEFORE UPDATE OR DELETE ON "signature_evidence"
FOR EACH ROW EXECUTE FUNCTION "signature_evidence_immutable"();

-- Pas de TRUNCATE non plus (il ne déclenche pas les déclencheurs par ligne).
CREATE TRIGGER "signature_evidence_no_truncate"
BEFORE TRUNCATE ON "signature_evidence"
FOR EACH STATEMENT EXECUTE FUNCTION "signature_evidence_immutable"();
