-- Prestation ponctuelle d'une organisation (ADR-049) : facturée en une fois, en entier, sur la
-- facture du mois de son passage, et non plus au prorata sur deux mois. Les contrats existants
-- gardent leur facturation (false) : leurs factures déjà émises ne changent pas.
ALTER TABLE "billing_contracts" ADD COLUMN "one_off" BOOLEAN NOT NULL DEFAULT false;
