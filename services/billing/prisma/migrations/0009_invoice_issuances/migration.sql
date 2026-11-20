-- Lot E — facture de séance et reçu des frais de visite émis au paiement par cleaning
-- (InvoiceIssuanceService.IssueInvoice ; CDC Nettoyage v2, R-PP-06 et R-FV-04 ; ADR-055 décisions 4
-- et 9). Dépend de 0008_lot_f_monthly_invoices : une facture v2 n'a ni contrat ni rang de mois, et sa
-- nature est portée par invoices.kind ("session" ou "visit_fee").
--
-- Migration additive, sans toucher à la table invoices : ce qui est propre à l'émission au paiement
-- vit dans invoice_issuances, une ligne par facture émise (relation 1-1, facultative côté facture).
-- Idempotence par (émetteur, clé) : un appel rejoué rend la même facture ; l'empreinte du contenu
-- distingue un rejeu d'une clé réutilisée pour un autre contenu. Objet facturé et références
-- lisibles (dossier, programme, rang, nom du lieu) ; jamais d'adresse ni de position.

-- CreateTable
CREATE TABLE "invoice_issuances" (
    "issuer" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "invoice_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source_object_type" TEXT NOT NULL,
    "source_object_id" UUID NOT NULL,
    "request_number" TEXT,
    "program_number" TEXT,
    "session_rank" TEXT,
    "place_label" TEXT,
    "service_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_issuances_pkey" PRIMARY KEY ("issuer","idempotency_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_issuances_invoice_id_key" ON "invoice_issuances"("invoice_id");

-- AddForeignKey
ALTER TABLE "invoice_issuances" ADD CONSTRAINT "invoice_issuances_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
