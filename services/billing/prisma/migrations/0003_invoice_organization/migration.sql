-- En-tête des factures d'organisation : fiche lue dans identity au moment de l'émission
-- (raison sociale, adresse, IFU, RCCM). Ajout seulement ; les factures déjà émises restent sans
-- en-tête (colonnes nulles).

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "organization_address" TEXT,
ADD COLUMN     "organization_ifu" TEXT,
ADD COLUMN     "organization_legal_name" TEXT,
ADD COLUMN     "organization_rccm" TEXT;
