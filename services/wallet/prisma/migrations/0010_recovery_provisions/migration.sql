-- ADR-060, point 10 : KSP n'avance jamais de frais de procédure. Le créancier verse une provision
-- depuis son portefeuille prépayé (débit de recovery, objet « recovery_provision ») ; elle est tenue
-- sur un compte interne propre (passif, sens crédit : argent du créancier, pas un produit de KSP),
-- et non sur « ksp:service_revenue ». Ajout seulement : les écritures existantes restent
-- immuables (aucune ligne n'est modifiée).
--
-- Invariant : fonds des recharges = Σ portefeuilles + services payés + retraits en transit +
-- provisions du recouvrement.
INSERT INTO "ledger_accounts" ("code", "kind", "normal_side") VALUES
  ('ksp:recovery_provisions', 'internal', 'credit');
