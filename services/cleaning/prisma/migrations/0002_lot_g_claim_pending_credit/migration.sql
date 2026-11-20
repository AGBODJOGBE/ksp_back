-- Lot G, R-RC-03 : un crédit de plus de 50 000 FCFA attend la validation d'une deuxième personne
-- (DecideClaim, puis ApproveClaimCredit). La contrainte d'origine exigeait le second validateur dès
-- l'enregistrement de la décision, ce qui rendait l'attente impossible à écrire. La garantie reste :
-- une réclamation close (résolue ou rejetée) avec un tel crédit porte un second validateur, autre que
-- l'auteur de la décision ; en attente, la réclamation reste ouverte ou en cours, sans validateur.
ALTER TABLE "claims" DROP CONSTRAINT "claims_credit_approval_check";
ALTER TABLE "claims" ADD CONSTRAINT "claims_credit_approval_check" CHECK (
  "credit_amount" IS NULL OR "credit_amount" <= 50000
  OR ("credit_approved_by" IS NULL AND "status" IN ('open', 'in_progress'))
  OR ("credit_approved_by" IS NOT NULL AND "credit_approved_by" IS DISTINCT FROM "decided_by")
);
