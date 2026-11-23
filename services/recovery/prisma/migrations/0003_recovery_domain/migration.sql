-- Modèle du Recouvrement (ADR-060 à 063) : dossiers, débiteurs (coordonnées chiffrées), créances,
-- échéanciers, décisions, partenaires, argent, imports, accès du débiteur, tarification, réglages,
-- journal de preuve en ajout seul et journal d'audit.

-- CreateEnum
CREATE TYPE "CaseKind" AS ENUM ('b2b', 'b2c', 'rent');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('draft', 'awaiting_fee', 'under_review', 'info_requested', 'active', 'suspended', 'closed', 'rejected');

-- CreateEnum
CREATE TYPE "CaseStage" AS ENUM ('notice', 'payment_plan', 'amicable', 'formal_notice', 'bailiff', 'litigation');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('user', 'organization');

-- CreateTable
CREATE TABLE "recovery_cases" (
    "id" UUID NOT NULL,
    "sequence" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "CaseKind" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'draft',
    "stage" "CaseStage",
    "highest_stage" "CaseStage",
    "creditor_type" "PartyType" NOT NULL,
    "creditor_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "nature" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'form',
    "import_id" UUID,
    "commune_key" TEXT,
    "relationship_to_preserve" BOOLEAN NOT NULL DEFAULT false,
    "preferences" JSONB,
    "assigned_agent_id" UUID,
    "score" INTEGER,
    "score_breakdown" JSONB,
    "rejection_reason" TEXT,
    "closure_reason" TEXT,
    "mandate_document_id" UUID,
    "mandate_signed_at" TIMESTAMPTZ(3),
    "fee_rule_id" UUID,
    "fee_rule_version" INTEGER,
    "commission_rule_id" UUID,
    "commission_rule_version" INTEGER,
    "commission_summary" TEXT,
    "case_fee" INTEGER NOT NULL DEFAULT 0,
    "case_fee_paid_at" TIMESTAMPTZ(3),
    "case_fee_debit_reference" TEXT,
    "principal" INTEGER NOT NULL DEFAULT 0,
    "interests" INTEGER NOT NULL DEFAULT 0,
    "costs" INTEGER NOT NULL DEFAULT 0,
    "paid" INTEGER NOT NULL DEFAULT 0,
    "commissioned_base" INTEGER NOT NULL DEFAULT 0,
    "commission_total" INTEGER NOT NULL DEFAULT 0,
    "earliest_due_date" DATE,
    "prescription_date" DATE,
    "idempotency_key" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "accepted_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "stopped_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recovery_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debtors" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'main',
    "kind" TEXT NOT NULL,
    "identity_enc" TEXT NOT NULL,
    "addresses_enc" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "debtors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debtor_contacts" (
    "id" UUID NOT NULL,
    "debtor_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "value_enc" TEXT NOT NULL,
    "value_index" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debtor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "principal" INTEGER NOT NULL,
    "interests" INTEGER NOT NULL DEFAULT 0,
    "due_date" DATE NOT NULL,
    "description" TEXT,
    "paid_before" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prior_efforts" (
    "case_id" UUID NOT NULL,
    "reminders_count" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" DATE,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgment_file_id" UUID,
    "promises" TEXT,
    "notes" TEXT,

    CONSTRAINT "prior_efforts_pkey" PRIMARY KEY ("case_id")
);

-- CreateTable
CREATE TABLE "case_documents" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "claim_id" UUID,
    "file_id" UUID,
    "document_id" UUID,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "visible_to_partner" BOOLEAN NOT NULL DEFAULT false,
    "visible_to_debtor" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by_type" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "by_type" TEXT NOT NULL,
    "by_id" UUID,
    "outcome" TEXT,
    "delivery_status" TEXT,
    "note" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_promises" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" UUID NOT NULL,
    "kept_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_promises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "terms" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "out_of_scale" BOOLEAN NOT NULL DEFAULT false,
    "violations" JSONB,
    "proposed_by_type" TEXT NOT NULL,
    "proposed_by_id" UUID,
    "renegotiated_from_id" UUID,
    "signature_request_id" UUID,
    "signed_document_id" UUID,
    "signed_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "paid" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "paid_at" TIMESTAMPTZ(3),

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "requested_by" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "answer" JSONB,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_transitions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "from" "CaseStage",
    "to" "CaseStage" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "by_type" TEXT NOT NULL,
    "by_id" UUID,
    "reason" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "stage_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notices" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "document_number" TEXT NOT NULL,
    "signed_by" UUID,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    "delivery_method" TEXT,
    "proof_file_id" UUID,

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" UUID,
    "display_name" TEXT NOT NULL,
    "office" TEXT NOT NULL,
    "areas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contacts_enc" TEXT,
    "fee_schedule" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(3),
    "verified_by" UUID,
    "average_delay_days" INTEGER,
    "success_rate_bps" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_assignments" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assigned_by" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL,
    "quote_document_id" UUID,
    "last_update_at" TIMESTAMPTZ(3) NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdraw_reason" TEXT,

    CONSTRAINT "partner_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acts" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "act_date" DATE NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "file_id" UUID,
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "decision_id" UUID,
    "assignment_id" UUID,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "debit_reference" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "consumed_amount" INTEGER NOT NULL DEFAULT 0,
    "refunded_amount" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "payment_link_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "installment_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "gross" INTEGER NOT NULL,
    "allocated_costs" INTEGER NOT NULL,
    "allocated_interests" INTEGER NOT NULL,
    "allocated_principal" INTEGER NOT NULL,
    "overpaid" INTEGER NOT NULL DEFAULT 0,
    "commission_base" INTEGER NOT NULL,
    "commission" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "stage_group" TEXT NOT NULL,
    "rule_id" UUID,
    "rule_version" INTEGER,
    "wallet_transaction_id" UUID,
    "credited_at" TIMESTAMPTZ(3),
    "collected_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_payments" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "external_ref" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "partner_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "collection_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_imports" (
    "id" UUID NOT NULL,
    "creditor_type" "PartyType" NOT NULL,
    "creditor_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "file_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'validating',
    "lines_total" INTEGER NOT NULL DEFAULT 0,
    "lines_valid" INTEGER NOT NULL DEFAULT 0,
    "lines_invalid" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "case_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_import_lines" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "values_enc" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errors" JSONB,
    "case_id" UUID,

    CONSTRAINT "case_import_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "text_enc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "creditor_answer_due" TIMESTAMPTZ(3) NOT NULL,
    "creditor_answer_at" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callback_requests" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "slot_start" TIMESTAMPTZ(3) NOT NULL,
    "slot_end" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "handled_by" UUID,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "callback_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debtor_accesses" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "debtor_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "code_hash" TEXT,
    "code_expires_at" TIMESTAMPTZ(3),
    "code_sent_at" TIMESTAMPTZ(3),
    "codes_sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debtor_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debtor_sessions" (
    "id" UUID NOT NULL,
    "access_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debtor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "fixed_amount" INTEGER,
    "rate_bps" INTEGER,
    "tiers" JSONB,
    "stage_rates" JSONB,
    "minimum" INTEGER,
    "maximum" INTEGER,
    "offer" TEXT NOT NULL,
    "commune_key" TEXT,
    "creditor_type" "PartyType",
    "creditor_id" UUID,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "published_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "archive_reason" TEXT,
    "previous_version_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "values" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "recovery_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "evidence_entries" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "channel" TEXT,
    "summary" TEXT NOT NULL,
    "outcome" TEXT,
    "delivery_status" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "ref_type" TEXT,
    "ref_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "details" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_cases_sequence_key" ON "recovery_cases"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_cases_number_key" ON "recovery_cases"("number");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_cases_case_fee_debit_reference_key" ON "recovery_cases"("case_fee_debit_reference");

-- CreateIndex
CREATE INDEX "recovery_cases_creditor_type_creditor_id_status_idx" ON "recovery_cases"("creditor_type", "creditor_id", "status");

-- CreateIndex
CREATE INDEX "recovery_cases_status_stage_idx" ON "recovery_cases"("status", "stage");

-- CreateIndex
CREATE INDEX "recovery_cases_assigned_agent_id_status_idx" ON "recovery_cases"("assigned_agent_id", "status");

-- CreateIndex
CREATE INDEX "recovery_cases_prescription_date_idx" ON "recovery_cases"("prescription_date");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_cases_creditor_type_creditor_id_idempotency_key_key" ON "recovery_cases"("creditor_type", "creditor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "debtors_case_id_idx" ON "debtors"("case_id");

-- CreateIndex
CREATE INDEX "debtor_contacts_debtor_id_idx" ON "debtor_contacts"("debtor_id");

-- CreateIndex
CREATE INDEX "debtor_contacts_value_index_idx" ON "debtor_contacts"("value_index");

-- CreateIndex
CREATE INDEX "claims_case_id_idx" ON "claims"("case_id");

-- CreateIndex
CREATE INDEX "claims_reference_idx" ON "claims"("reference");

-- CreateIndex
CREATE INDEX "case_documents_case_id_idx" ON "case_documents"("case_id");

-- CreateIndex
CREATE INDEX "contacts_case_id_occurred_at_idx" ON "contacts"("case_id", "occurred_at");

-- CreateIndex
CREATE INDEX "payment_promises_status_due_date_idx" ON "payment_promises"("status", "due_date");

-- CreateIndex
CREATE INDEX "payment_promises_case_id_idx" ON "payment_promises"("case_id");

-- CreateIndex
CREATE INDEX "payment_plans_case_id_status_idx" ON "payment_plans"("case_id", "status");

-- CreateIndex
CREATE INDEX "installments_status_due_date_idx" ON "installments"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "installments_plan_id_rank_key" ON "installments"("plan_id", "rank");

-- CreateIndex
CREATE INDEX "decisions_case_id_status_idx" ON "decisions"("case_id", "status");

-- CreateIndex
CREATE INDEX "decisions_status_expires_at_idx" ON "decisions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "stage_transitions_case_id_at_idx" ON "stage_transitions"("case_id", "at");

-- CreateIndex
CREATE INDEX "notices_case_id_kind_idx" ON "notices"("case_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "partners_user_id_key" ON "partners"("user_id");

-- CreateIndex
CREATE INDEX "partners_kind_status_idx" ON "partners"("kind", "status");

-- CreateIndex
CREATE INDEX "partner_assignments_partner_id_status_idx" ON "partner_assignments"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_assignments_case_id_idx" ON "partner_assignments"("case_id");

-- CreateIndex
CREATE INDEX "partner_assignments_status_last_update_at_idx" ON "partner_assignments"("status", "last_update_at");

-- CreateIndex
CREATE INDEX "legal_acts_case_id_act_date_idx" ON "legal_acts"("case_id", "act_date");

-- CreateIndex
CREATE UNIQUE INDEX "provisions_debit_reference_key" ON "provisions"("debit_reference");

-- CreateIndex
CREATE INDEX "provisions_case_id_idx" ON "provisions"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_payment_link_id_key" ON "payment_requests"("payment_link_id");

-- CreateIndex
CREATE INDEX "payment_requests_case_id_status_idx" ON "payment_requests"("case_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "collections_reference_key" ON "collections"("reference");

-- CreateIndex
CREATE INDEX "collections_case_id_collected_at_idx" ON "collections"("case_id", "collected_at");

-- CreateIndex
CREATE INDEX "collections_credited_at_idx" ON "collections"("credited_at");

-- CreateIndex
CREATE UNIQUE INDEX "offline_payments_collection_id_key" ON "offline_payments"("collection_id");

-- CreateIndex
CREATE INDEX "offline_payments_status_created_at_idx" ON "offline_payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "offline_payments_recorded_by_idempotency_key_key" ON "offline_payments"("recorded_by", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "case_imports_creditor_type_creditor_id_idempotency_key_key" ON "case_imports"("creditor_type", "creditor_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "case_import_lines_import_id_row_number_key" ON "case_import_lines"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "disputes_case_id_status_idx" ON "disputes"("case_id", "status");

-- CreateIndex
CREATE INDEX "callback_requests_status_slot_start_idx" ON "callback_requests"("status", "slot_start");

-- CreateIndex
CREATE UNIQUE INDEX "debtor_accesses_token_hash_key" ON "debtor_accesses"("token_hash");

-- CreateIndex
CREATE INDEX "debtor_accesses_case_id_idx" ON "debtor_accesses"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "debtor_sessions_token_hash_key" ON "debtor_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "debtor_sessions_expires_at_idx" ON "debtor_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "pricing_rules_object_status_idx" ON "pricing_rules"("object", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rules_created_by_idempotency_key_key" ON "pricing_rules"("created_by", "idempotency_key");

-- CreateIndex
CREATE INDEX "evidence_entries_case_id_occurred_at_idx" ON "evidence_entries"("case_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "debtors" ADD CONSTRAINT "debtors_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debtor_contacts" ADD CONSTRAINT "debtor_contacts_debtor_id_fkey" FOREIGN KEY ("debtor_id") REFERENCES "debtors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_efforts" ADD CONSTRAINT "prior_efforts_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "payment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_assignments" ADD CONSTRAINT "partner_assignments_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_assignments" ADD CONSTRAINT "partner_assignments_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acts" ADD CONSTRAINT "legal_acts_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "partner_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisions" ADD CONSTRAINT "provisions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_import_lines" ADD CONSTRAINT "case_import_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "case_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callback_requests" ADD CONSTRAINT "callback_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debtor_accesses" ADD CONSTRAINT "debtor_accesses_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debtor_sessions" ADD CONSTRAINT "debtor_sessions_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "debtor_accesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_entries" ADD CONSTRAINT "evidence_entries_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Journal de preuve en ajout seul (R-PR-08) : aucune modification ; une suppression n'est permise
-- que pendant la purge d'un dossier clos au-delà de sa durée de conservation (17.1, décision 14),
-- qui pose « SET LOCAL recovery.evidence_purge = 'on' » dans sa transaction.
CREATE FUNCTION evidence_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('recovery.evidence_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Le journal de preuve est en ajout seul : % interdit', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "evidence_entries_append_only" BEFORE UPDATE OR DELETE ON "evidence_entries"
  FOR EACH ROW EXECUTE FUNCTION evidence_append_only();

-- Un seul lien de paiement actif par dossier (ADR-060), une seule décision en attente par type,
-- une seule assignation active par dossier (index partiels, non exprimables dans schema.prisma).
CREATE UNIQUE INDEX "payment_requests_one_active_idx" ON "payment_requests"("case_id")
  WHERE "status" IN ('pending', 'active');
CREATE UNIQUE INDEX "decisions_one_pending_idx" ON "decisions"("case_id", "type")
  WHERE "status" = 'pending';
CREATE UNIQUE INDEX "partner_assignments_one_active_idx" ON "partner_assignments"("case_id")
  WHERE "status" = 'active';
