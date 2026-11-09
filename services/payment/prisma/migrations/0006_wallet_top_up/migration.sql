-- ADR-046 : objet « wallet_top_up » (recharge du portefeuille prépayé), payé par un compte connecté
-- comme une mission ou une facture. Réservé : un lien de paiement ne peut pas le porter.
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_subject_type_check";
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_subject_type_check" CHECK (
  "subject_type" ~ '^[a-z][a-z0-9_]{2,49}$'
  AND "subject_type" NOT IN ('cleaning_mission', 'billing_invoice', 'wallet_top_up')
);
