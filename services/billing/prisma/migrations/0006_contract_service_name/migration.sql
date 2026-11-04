-- Nom de la prestation du contrat (ADR-035), repris dans le libellé des lignes de facture.
-- Facultatif : les contrats existants gardent le libellé générique.
ALTER TABLE "billing_contracts" ADD COLUMN "service_name" TEXT;
