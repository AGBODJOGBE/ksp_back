-- ADR-044 : documents produits à partir de modèles, demandes de signature par code, preuves.

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "owner_id" UUID,
    "producer_service" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "file_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "signed_file_id" UUID,
    "signed_sha256" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "signed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id"),
    -- Garde-fous écrits à la main (non exprimables dans schema.prisma).
    CONSTRAINT "documents_status_check" CHECK ("status" IN ('draft', 'pending_signature', 'signed', 'expired', 'cancelled')),
    CONSTRAINT "documents_signed_check" CHECK (("status" = 'signed') = ("signed_file_id" IS NOT NULL AND "signed_sha256" IS NOT NULL AND "signed_at" IS NOT NULL)),
    CONSTRAINT "documents_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND ("signed_sha256" IS NULL OR "signed_sha256" ~ '^[0-9a-f]{64}$'))
);

-- CreateTable
CREATE TABLE "document_counters" (
    "prefix" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("prefix","year")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "signer_user_id" UUID,
    "signer_phone_e164" TEXT,
    "signer_email" TEXT,
    "signer_phone_masked" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "token_hash" TEXT,
    "document_sha256" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "signed_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "signature_requests_status_check" CHECK ("status" IN ('pending', 'signed', 'expired', 'cancelled')),
    -- Coordonnées en clair seulement tant que la demande est en attente.
    CONSTRAINT "signature_requests_contact_check" CHECK ("status" = 'pending' OR ("signer_phone_e164" IS NULL AND "signer_email" IS NULL))
);

-- CreateTable
CREATE TABLE "signature_codes" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "signature_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_evidence" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL,
    "method" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code_id" UUID NOT NULL,
    "signer_user_id" UUID,
    "signer_name" TEXT NOT NULL,
    "signer_phone_masked" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "document_sha256" TEXT NOT NULL,
    "signed_file_id" UUID NOT NULL,
    "signed_sha256" TEXT NOT NULL,
    "consent" BOOLEAN NOT NULL,
    "certificate_version" INTEGER NOT NULL,

    CONSTRAINT "signature_evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "signature_evidence_consent_check" CHECK ("consent")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_number_key" ON "documents"("number");
CREATE UNIQUE INDEX "documents_producer_service_idempotency_key_key" ON "documents"("producer_service", "idempotency_key");
CREATE INDEX "documents_owner_id_idx" ON "documents"("owner_id");
CREATE INDEX "documents_subject_type_subject_id_idx" ON "documents"("subject_type", "subject_id");
CREATE UNIQUE INDEX "signature_requests_token_hash_key" ON "signature_requests"("token_hash");
CREATE UNIQUE INDEX "signature_requests_document_id_idempotency_key_key" ON "signature_requests"("document_id", "idempotency_key");
CREATE INDEX "signature_requests_document_id_created_at_idx" ON "signature_requests"("document_id", "created_at");
CREATE INDEX "signature_requests_signer_user_id_idx" ON "signature_requests"("signer_user_id");
CREATE INDEX "signature_codes_request_id_created_at_idx" ON "signature_codes"("request_id", "created_at");
CREATE UNIQUE INDEX "signature_evidence_request_id_key" ON "signature_evidence"("request_id");
CREATE INDEX "signature_evidence_signer_user_id_idx" ON "signature_evidence"("signer_user_id");

-- Une seule demande en attente par document (index partiel, non exprimable dans schema.prisma).
CREATE UNIQUE INDEX "signature_requests_one_pending_idx" ON "signature_requests"("document_id") WHERE "status" = 'pending';
-- Clôture des demandes expirées (tâche planifiée).
CREATE INDEX "signature_requests_pending_expiry_idx" ON "signature_requests"("expires_at") WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signature_codes" ADD CONSTRAINT "signature_codes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signature_evidence" ADD CONSTRAINT "signature_evidence_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
