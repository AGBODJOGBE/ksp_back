-- Module Nettoyage v2 : migration de départ (cahier des charges Nettoyage v2, partie 15.1).
-- Remplace les migrations 0001 à 0017 de la v1 (environnement de développement, aucune donnée à
-- reprendre). Le corps est généré par `prisma migrate diff --from-empty --to-schema-datamodel` ;
-- ce qui n'est pas exprimable dans schema.prisma est écrit à la main, en tête et en fin de fichier.

-- Contraintes d'exclusion avec égalité sur un uuid ou un entier (index GiST) : extension de confiance,
-- installable par le propriétaire de la base sans droits de super-utilisateur.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Numéros lisibles DN-000124 (demandes) et PN-000057 (programmes) : six chiffres au moins, sans
-- troncature au-delà de 999 999. Les trous de séquence (transaction annulée) sont acceptés.
CREATE FUNCTION "cleaning_format_number"(prefix TEXT, n BIGINT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT prefix || lpad(n::TEXT, greatest(6, length(n::TEXT)), '0') $$;

CREATE SEQUENCE "cleaning_request_number_seq" AS BIGINT START WITH 1;
CREATE SEQUENCE "cleaning_program_number_seq" AS BIGINT START WITH 1;

-- CreateEnum
CREATE TYPE "parameter_kind" AS ENUM ('number', 'choice', 'boolean');

-- CreateEnum
CREATE TYPE "tariff_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "bracket_mode" AS ENUM ('flat', 'per_unit');

-- CreateEnum
CREATE TYPE "supplement_mode" AS ENUM ('fixed', 'per_unit', 'coefficient');

-- CreateEnum
CREATE TYPE "planning_mode" AS ENUM ('manual', 'proposal', 'automatic');

-- CreateEnum
CREATE TYPE "owner_kind" AS ENUM ('user', 'organization');

-- CreateEnum
CREATE TYPE "request_status" AS ENUM ('awaiting_visit_fee', 'visit_to_schedule', 'visit_scheduled', 'visit_missed', 'visit_done', 'quote_sent', 'accepted', 'declined', 'expired', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "visit_fee_status" AS ENUM ('awaiting_payment', 'paid', 'refunded', 'retained', 'deducted');

-- CreateEnum
CREATE TYPE "reactivation_status" AS ENUM ('pending', 'accepted', 'refused');

-- CreateEnum
CREATE TYPE "visit_status" AS ENUM ('scheduled', 'in_progress', 'completed', 'missed', 'cancelled');

-- CreateEnum
CREATE TYPE "visit_cancel_cause" AS ENUM ('request_cancelled', 'request_rejected', 'slot_changed', 'ksp', 'agent_no_show');

-- CreateEnum
CREATE TYPE "quote_status" AS ENUM ('draft', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'withdrawn');

-- CreateEnum
CREATE TYPE "quote_kind" AS ENUM ('initial', 'amendment', 'renewal', 'reorder');

-- CreateEnum
CREATE TYPE "payer_kind" AS ENUM ('individual', 'organization');

-- CreateEnum
CREATE TYPE "program_status" AS ENUM ('confirmed', 'in_progress', 'suspended', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "suspension_cause" AS ENUM ('overdue_sessions', 'unpaid_invoices', 'ksp_decision', 'organization_suspended');

-- CreateEnum
CREATE TYPE "cancelled_by" AS ENUM ('customer', 'ksp');

-- CreateEnum
CREATE TYPE "renewal_status" AS ENUM ('proposed', 'accepted', 'declined');

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('to_assign', 'assigned', 'in_progress', 'interrupted', 'completed', 'missed', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "session_payment_status" AS ENUM ('not_due', 'due', 'paid', 'overdue', 'waived');

-- CreateEnum
CREATE TYPE "session_missed_cause" AS ENUM ('customer_absent', 'access_impossible');

-- CreateEnum
CREATE TYPE "session_cancel_cause" AS ENUM ('customer', 'customer_late', 'ksp', 'no_agent', 'program_stopped');

-- CreateEnum
CREATE TYPE "session_staffing_alert" AS ENUM ('unassigned_48h', 'unassigned_at_start', 'agent_absent');

-- CreateEnum
CREATE TYPE "incident_kind" AS ENUM ('equipment', 'access', 'safety', 'out_of_scope_request', 'other');

-- CreateEnum
CREATE TYPE "incident_decision" AS ENUM ('pending', 'resumed', 'rescheduled', 'cancelled');

-- CreateEnum
CREATE TYPE "agent_status" AS ENUM ('applicant', 'under_review', 'active', 'suspended', 'deactivated', 'rejected');

-- CreateEnum
CREATE TYPE "employment_kind" AS ENUM ('employee', 'independent');

-- CreateEnum
CREATE TYPE "agent_skill_status" AS ENUM ('declared', 'validated', 'rejected');

-- CreateEnum
CREATE TYPE "unavailability_kind" AS ENUM ('unavailable', 'extra_availability');

-- CreateEnum
CREATE TYPE "unavailability_reason" AS ENUM ('leave', 'sickness', 'other');

-- CreateEnum
CREATE TYPE "assignment_target" AS ENUM ('visit', 'session');

-- CreateEnum
CREATE TYPE "assignment_source" AS ENUM ('manual', 'auto');

-- CreateEnum
CREATE TYPE "assignment_status" AS ENUM ('proposed', 'pending_confirmation', 'confirmed', 'declined', 'expired', 'removed');

-- CreateEnum
CREATE TYPE "assignment_override" AS ENUM ('zone', 'availability', 'load', 'team_size');

-- CreateEnum
CREATE TYPE "claim_reason" AS ENUM ('incomplete_work', 'damage', 'behavior', 'missing_item', 'other');

-- CreateEnum
CREATE TYPE "claim_status" AS ENUM ('open', 'in_progress', 'resolved', 'rejected');

-- CreateEnum
CREATE TYPE "claim_decision" AS ENUM ('free_redo', 'wallet_credit', 'rejected');

-- CreateEnum
CREATE TYPE "wallet_operation_kind" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "wallet_operation_purpose" AS ENUM ('visit_fee', 'visit_fee_refund', 'session_payment', 'claim_credit', 'commercial_gesture');

-- CreateEnum
CREATE TYPE "wallet_operation_status" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "direct_payment_status" AS ENUM ('pending', 'succeeded', 'failed', 'expired', 'left_in_wallet');

-- CreateEnum
CREATE TYPE "invoice_standing" AS ENUM ('overdue', 'paid');

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "parked_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "first_failed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id","consumer")
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

-- CreateTable
CREATE TABLE "idempotency_records" (
    "actor_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("actor_id","operation","idempotency_key")
);

-- CreateTable
CREATE TABLE "place_categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL,
    "photo_file_id" UUID,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "visit_fee" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "place_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place_types" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL,
    "photo_file_id" UUID,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_other" BOOLEAN NOT NULL DEFAULT false,
    "area_parameter_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "place_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleaning_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL,
    "required_skill_code" TEXT,
    "reference_duration_minutes" INTEGER NOT NULL,
    "checklist_template" JSONB NOT NULL DEFAULT '[]',
    "is_pack" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "cleaning_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_items" (
    "pack_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,

    CONSTRAINT "pack_items_pkey" PRIMARY KEY ("pack_id","item_id")
);

-- CreateTable
CREATE TABLE "parameters" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "parameter_kind" NOT NULL,
    "unit" TEXT,
    "min_value" INTEGER,
    "max_value" INTEGER,
    "choices" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "help" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place_type_parameters" (
    "place_type_id" UUID NOT NULL,
    "parameter_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "place_type_parameters_pkey" PRIMARY KEY ("place_type_id","parameter_id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "place_type_id" UUID NOT NULL,
    "cleaning_type_id" UUID NOT NULL,
    "team_rule" JSONB NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_parameters" (
    "offer_id" UUID NOT NULL,
    "parameter_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "offer_parameters_pkey" PRIMARY KEY ("offer_id","parameter_id")
);

-- CreateTable
CREATE TABLE "tariff_versions" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "tariff_status" NOT NULL DEFAULT 'draft',
    "base_parameter_id" UUID,
    "pack_discount_bp" INTEGER,
    "minimum_price" INTEGER NOT NULL,
    "frequency_coefficients" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "tariff_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_brackets" (
    "id" UUID NOT NULL,
    "tariff_version_id" UUID NOT NULL,
    "from_value" INTEGER NOT NULL,
    "to_value" INTEGER NOT NULL,
    "mode" "bracket_mode" NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "tariff_brackets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_supplements" (
    "id" UUID NOT NULL,
    "tariff_version_id" UUID NOT NULL,
    "parameter_id" UUID NOT NULL,
    "choice_code" TEXT,
    "mode" "supplement_mode" NOT NULL,
    "amount" INTEGER,
    "coefficient_bp" INTEGER,
    "included_units" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tariff_supplements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL,
    "commune_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coefficient_bp" INTEGER NOT NULL DEFAULT 10000,
    "visit_fee_surcharge" INTEGER,
    "planning_mode" "planning_mode",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_holidays" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "places" (
    "id" UUID NOT NULL,
    "owner_kind" "owner_kind" NOT NULL,
    "owner_id" UUID NOT NULL,
    "place_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gps_encrypted" TEXT,
    "landmark_encrypted" TEXT,
    "address_encrypted" TEXT,
    "readable_address_encrypted" TEXT,
    "commune_key" TEXT NOT NULL,
    "commune_boundaries_version" TEXT,
    "declared_values" JSONB NOT NULL DEFAULT '{}',
    "location_erased_at" TIMESTAMPTZ(3),
    "location_corrected_at" TIMESTAMPTZ(3),
    "location_corrected_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleaning_requests" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL DEFAULT cleaning_format_number('DN-'::text, nextval('cleaning_request_number_seq'::regclass)),
    "owner_kind" "owner_kind" NOT NULL,
    "owner_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "place_id" UUID NOT NULL,
    "place_type_id" UUID NOT NULL,
    "commune_key" TEXT NOT NULL,
    "gps_encrypted" TEXT,
    "landmark_encrypted" TEXT,
    "address_encrypted" TEXT,
    "readable_address_encrypted" TEXT,
    "commune_boundaries_version" TEXT,
    "location_erased_at" TIMESTAMPTZ(3),
    "status" "request_status" NOT NULL,
    "declared_values" JSONB NOT NULL,
    "declared_rows" JSONB NOT NULL DEFAULT '[]',
    "schedule_plan" JSONB NOT NULL,
    "visit_slots" JSONB NOT NULL,
    "pricing_snapshot" JSONB,
    "estimated_session_price" INTEGER,
    "description" TEXT,
    "comment" TEXT,
    "photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "closing_reason" TEXT,
    "closing_reason_code" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cleaning_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_fees" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "visit_fee_status" NOT NULL DEFAULT 'awaiting_payment',
    "due_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "invoice_id" UUID,
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "visit_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_reactivations" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "reactivation_status" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reason" TEXT,

    CONSTRAINT "request_reactivations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_items" (
    "request_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "tariff_version_id" UUID,

    CONSTRAINT "request_items_pkey" PRIMARY KEY ("request_id","offer_id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "visit_fee_id" UUID NOT NULL,
    "status" "visit_status" NOT NULL DEFAULT 'scheduled',
    "scheduled_start" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "arrived_at" TIMESTAMPTZ(3),
    "arrival_gps_encrypted" TEXT,
    "arrival_distance_m" INTEGER,
    "observed_values" JSONB,
    "observed_rows" JSONB,
    "observation_note" TEXT,
    "observed_pricing" JSONB,
    "observed_by" UUID,
    "observed_at" TIMESTAMPTZ(3),
    "photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "missed_photo_file_id" UUID,
    "missed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_cause" "visit_cancel_cause",
    "change_reason" TEXT,
    "closed_by_staff" BOOLEAN NOT NULL DEFAULT false,
    "closed_by" UUID,
    "closed_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retained_values" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" TEXT,
    "visit_id" UUID,
    "values" JSONB NOT NULL,
    "pricing_snapshot" JSONB NOT NULL,
    "rows" JSONB NOT NULL DEFAULT '[]',
    "diff" JSONB NOT NULL DEFAULT '[]',
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "author_id" UUID NOT NULL,
    "locked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "retained_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "quote_kind" NOT NULL DEFAULT 'initial',
    "program_id" UUID,
    "retained_values_id" UUID,
    "status" "quote_status" NOT NULL DEFAULT 'draft',
    "lines" JSONB NOT NULL,
    "session_price" INTEGER NOT NULL,
    "sessions_count" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "visit_fee_deduction" INTEGER NOT NULL DEFAULT 0,
    "team_size" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "schedule_plan" JSONB NOT NULL,
    "scheduled_dates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manual_adjustment" INTEGER,
    "manual_adjustment_reason" TEXT,
    "adjustment_approved_by" UUID,
    "valid_until" TIMESTAMPTZ(3),
    "expiry_reminded_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "sent_by" UUID,
    "responded_at" TIMESTAMPTZ(3),
    "responded_by" UUID,
    "decline_reason" JSONB,
    "accepted_start_date" DATE,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by" UUID,
    "withdrawal_reason" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL DEFAULT cleaning_format_number('PN-'::text, nextval('cleaning_program_number_seq'::regclass)),
    "request_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "owner_kind" "owner_kind" NOT NULL,
    "owner_id" UUID NOT NULL,
    "payer_kind" "payer_kind" NOT NULL,
    "place_id" UUID NOT NULL,
    "commune_key" TEXT NOT NULL,
    "status" "program_status" NOT NULL DEFAULT 'confirmed',
    "suspension_causes" "suspension_cause"[] DEFAULT ARRAY[]::"suspension_cause"[],
    "suspended_at" TIMESTAMPTZ(3),
    "session_price" INTEGER NOT NULL,
    "team_size" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "schedule_plan" JSONB NOT NULL,
    "visit_fee_to_deduct" INTEGER NOT NULL DEFAULT 0,
    "renewal_of_program_id" UUID,
    "renewal_status" "renewal_status",
    "renewal_proposed_at" TIMESTAMPTZ(3),
    "renewal_responded_at" TIMESTAMPTZ(3),
    "renewal_responded_by" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" "cancelled_by",
    "cancellation_reason" TEXT,
    "cancellation_approved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_suspension_causes" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "cause" "suspension_cause" NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL,
    "lifted_at" TIMESTAMPTZ(3),
    "reason" TEXT,
    "decided_by" UUID,
    "lifted_by" UUID,

    CONSTRAINT "program_suspension_causes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "commune_key" TEXT NOT NULL,
    "scheduled_start" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(3) NOT NULL,
    "status" "session_status" NOT NULL DEFAULT 'to_assign',
    "price" INTEGER NOT NULL,
    "amount_due" INTEGER,
    "visit_fee_deducted" INTEGER NOT NULL DEFAULT 0,
    "payment_status" "session_payment_status" NOT NULL DEFAULT 'not_due',
    "payment_due_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "invoice_id" UUID,
    "free_redo_of_claim_id" UUID,
    "arrived_at" TIMESTAMPTZ(3),
    "arrival_gps_encrypted" TEXT,
    "arrival_distance_m" INTEGER,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "before_photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "after_photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "signature_file_id" UUID,
    "missed_photo_file_id" UUID,
    "missed_cause" "session_missed_cause",
    "wait_started_at" TIMESTAMPTZ(3),
    "called_at" TIMESTAMPTZ(3),
    "missed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" "cancelled_by",
    "cancel_cause" "session_cancel_cause",
    "late_cancellation" BOOLEAN NOT NULL DEFAULT false,
    "change_reason" TEXT,
    "staffing_alert_level" "session_staffing_alert",
    "closed_by_staff" BOOLEAN NOT NULL DEFAULT false,
    "closed_by" UUID,
    "closed_reason" TEXT,
    "present_agent_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "catch_up_suggested_start" TIMESTAMPTZ(3),
    "reminded_at" TIMESTAMPTZ(3),
    "balance_alerted_at" TIMESTAMPTZ(3),
    "rating" INTEGER,
    "rating_comment" TEXT,
    "rated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_incidents" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kind" "incident_kind" NOT NULL,
    "note" TEXT NOT NULL,
    "photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "reported_by" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "decision" "incident_decision" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "session_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_reschedules" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "previous_start" TIMESTAMPTZ(3) NOT NULL,
    "previous_end" TIMESTAMPTZ(3) NOT NULL,
    "new_start" TIMESTAMPTZ(3) NOT NULL,
    "new_end" TIMESTAMPTZ(3) NOT NULL,
    "requested_by" "cancelled_by" NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_reschedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "agent_status" NOT NULL DEFAULT 'applicant',
    "employment_kind" "employment_kind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "photo_file_id" UUID,
    "home_commune_key" TEXT NOT NULL,
    "id_document_encrypted" TEXT,
    "emergency_contact_encrypted" TEXT,
    "mobile_money_encrypted" TEXT,
    "max_hours_day" INTEGER NOT NULL DEFAULT 8,
    "max_hours_week" INTEGER NOT NULL DEFAULT 48,
    "can_lead" BOOLEAN NOT NULL DEFAULT false,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "status_reason" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_skills" (
    "agent_id" UUID NOT NULL,
    "skill_code" TEXT NOT NULL,
    "status" "agent_skill_status" NOT NULL DEFAULT 'declared',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("agent_id","skill_code")
);

-- CreateTable
CREATE TABLE "agent_zones" (
    "agent_id" UUID NOT NULL,
    "commune_key" TEXT NOT NULL,

    CONSTRAINT "agent_zones_pkey" PRIMARY KEY ("agent_id","commune_key")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unavailabilities" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" "unavailability_kind" NOT NULL DEFAULT 'unavailable',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" "unavailability_reason",
    "note" TEXT,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "unavailabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lead_agent_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","agent_id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "target_kind" "assignment_target" NOT NULL,
    "visit_id" UUID,
    "session_id" UUID,
    "agent_id" UUID NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,
    "source" "assignment_source" NOT NULL,
    "status" "assignment_status" NOT NULL,
    "response_due_at" TIMESTAMPTZ(3),
    "responded_at" TIMESTAMPTZ(3),
    "occupied_from" TIMESTAMPTZ(3) NOT NULL,
    "occupied_until" TIMESTAMPTZ(3) NOT NULL,
    "travel_minutes" INTEGER NOT NULL DEFAULT 0,
    "overrides" "assignment_override"[] DEFAULT ARRAY[]::"assignment_override"[],
    "reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,
    "removal_reason" TEXT,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "opened_by" UUID NOT NULL,
    "reason" "claim_reason" NOT NULL,
    "text" TEXT NOT NULL,
    "photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "claim_status" NOT NULL DEFAULT 'open',
    "decision" "claim_decision",
    "decision_reason" TEXT,
    "credit_amount" INTEGER,
    "credit_note_id" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "credit_approved_by" UUID,
    "first_response_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_messages" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "from_staff" BOOLEAN NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "claim_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_operations" (
    "id" UUID NOT NULL,
    "kind" "wallet_operation_kind" NOT NULL,
    "purpose" "wallet_operation_purpose" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "wallet_owner_kind" "owner_kind" NOT NULL,
    "wallet_owner_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "request_id" UUID,
    "visit_fee_id" UUID,
    "session_id" UUID,
    "claim_id" UUID,
    "status" "wallet_operation_status" NOT NULL DEFAULT 'pending',
    "wallet_transaction_id" UUID,
    "failure_code" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "wallet_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direct_payments" (
    "id" UUID NOT NULL,
    "payment_request_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "purpose" "wallet_operation_purpose" NOT NULL,
    "payer_kind" "owner_kind" NOT NULL,
    "payer_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "request_id" UUID,
    "visit_fee_id" UUID,
    "session_id" UUID,
    "status" "direct_payment_status" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "direct_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invoices" (
    "invoice_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standing" "invoice_standing" NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_invoices_pkey" PRIMARY KEY ("invoice_id")
);

-- CreateTable
CREATE TABLE "organization_standings" (
    "organization_id" UUID NOT NULL,
    "suspended" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_standings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "organization_billing_standings" (
    "organization_id" UUID NOT NULL,
    "overdue_count" INTEGER NOT NULL DEFAULT 0,
    "warning_level" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "organization_billing_standings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "cleaning_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "max_open_requests" INTEGER NOT NULL DEFAULT 5,
    "min_visit_lead_hours" INTEGER NOT NULL DEFAULT 24,
    "visit_fee_payment_hours" INTEGER NOT NULL DEFAULT 72,
    "visit_target_hours" INTEGER NOT NULL DEFAULT 72,
    "visit_duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "default_travel_minutes" INTEGER NOT NULL DEFAULT 30,
    "default_visit_fee" INTEGER NOT NULL DEFAULT 0,
    "deduct_visit_fee" BOOLEAN NOT NULL DEFAULT true,
    "quote_validity_days" INTEGER NOT NULL DEFAULT 15,
    "quote_reminder_days" INTEGER NOT NULL DEFAULT 2,
    "max_discount_without_approval_pct" INTEGER NOT NULL DEFAULT 20,
    "first_session_lead_hours" INTEGER NOT NULL DEFAULT 48,
    "program_max_months" INTEGER NOT NULL DEFAULT 24,
    "program_max_sessions" INTEGER NOT NULL DEFAULT 400,
    "free_cancellation_hours" INTEGER NOT NULL DEFAULT 24,
    "max_reschedules_per_month" INTEGER NOT NULL DEFAULT 2,
    "late_cancellation_fee_pct" INTEGER NOT NULL DEFAULT 50,
    "session_payment_grace_hours" INTEGER NOT NULL DEFAULT 24,
    "overdue_sessions_before_suspension" INTEGER NOT NULL DEFAULT 1,
    "balance_guarantee" BOOLEAN NOT NULL DEFAULT false,
    "unpaid_invoices_warning" INTEGER NOT NULL DEFAULT 1,
    "unpaid_invoices_suspension" INTEGER NOT NULL DEFAULT 2,
    "default_planning_mode" "planning_mode" NOT NULL DEFAULT 'proposal',
    "planning_horizon_days" INTEGER NOT NULL DEFAULT 14,
    "score_weight_continuity" INTEGER NOT NULL DEFAULT 40,
    "score_weight_proximity" INTEGER NOT NULL DEFAULT 25,
    "score_weight_balance" INTEGER NOT NULL DEFAULT 20,
    "score_weight_rating" INTEGER NOT NULL DEFAULT 15,
    "assignment_response_hours" INTEGER NOT NULL DEFAULT 12,
    "default_max_hours_day" INTEGER NOT NULL DEFAULT 8,
    "default_max_hours_week" INTEGER NOT NULL DEFAULT 48,
    "max_photos_per_type" INTEGER NOT NULL DEFAULT 10,
    "claim_window_hours" INTEGER NOT NULL DEFAULT 48,
    "arrival_alert_meters" INTEGER NOT NULL DEFAULT 300,
    "arrival_max_advance_minutes" INTEGER NOT NULL DEFAULT 30,
    "customer_wait_minutes" INTEGER NOT NULL DEFAULT 30,
    "common_checklist" JSONB NOT NULL DEFAULT '[{"code":"arrival","label":"Arrivée sur place et accueil du client","order":0},{"code":"cleaning_done","label":"Prestation réalisée selon le devis","order":1},{"code":"site_left_clean","label":"Matériel rangé, déchets évacués","order":2},{"code":"customer_review","label":"Tour final avec le client","order":3}]',
    "retention_months" INTEGER NOT NULL DEFAULT 12,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cleaning_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idempotency_records_created_at_idx" ON "idempotency_records"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "place_categories_code_key" ON "place_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "place_types_code_key" ON "place_types"("code");

-- CreateIndex
CREATE INDEX "place_types_category_id_display_order_idx" ON "place_types"("category_id", "display_order");

-- CreateIndex
CREATE INDEX "place_types_area_parameter_id_idx" ON "place_types"("area_parameter_id");

-- CreateIndex
CREATE UNIQUE INDEX "skills_code_key" ON "skills"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cleaning_types_code_key" ON "cleaning_types"("code");

-- CreateIndex
CREATE INDEX "pack_items_item_id_idx" ON "pack_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "parameters_code_key" ON "parameters"("code");

-- CreateIndex
CREATE INDEX "place_type_parameters_parameter_id_idx" ON "place_type_parameters"("parameter_id");

-- CreateIndex
CREATE INDEX "offers_cleaning_type_id_idx" ON "offers"("cleaning_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_place_type_id_cleaning_type_id_key" ON "offers"("place_type_id", "cleaning_type_id");

-- CreateIndex
CREATE INDEX "offer_parameters_parameter_id_idx" ON "offer_parameters"("parameter_id");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_versions_offer_id_version_key" ON "tariff_versions"("offer_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_versions_id_offer_id_key" ON "tariff_versions"("id", "offer_id");

-- CreateIndex
CREATE INDEX "tariff_brackets_tariff_version_id_from_value_idx" ON "tariff_brackets"("tariff_version_id", "from_value");

-- CreateIndex
CREATE INDEX "tariff_supplements_parameter_id_idx" ON "tariff_supplements"("parameter_id");

-- CreateIndex
-- Un choix null compte comme une valeur : un seul supplément par paramètre sans choix (écrit à la main).
CREATE UNIQUE INDEX "tariff_supplements_parameter_choice_key" ON "tariff_supplements"("tariff_version_id", "parameter_id", "choice_code") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "zones_commune_key_key" ON "zones"("commune_key");

-- CreateIndex
CREATE UNIQUE INDEX "public_holidays_date_key" ON "public_holidays"("date");

-- CreateIndex
CREATE INDEX "places_owner_kind_owner_id_idx" ON "places"("owner_kind", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "cleaning_requests_number_key" ON "cleaning_requests"("number");

-- CreateIndex
CREATE INDEX "cleaning_requests_owner_kind_owner_id_status_idx" ON "cleaning_requests"("owner_kind", "owner_id", "status");

-- CreateIndex
CREATE INDEX "cleaning_requests_status_created_at_idx" ON "cleaning_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "cleaning_requests_commune_key_status_idx" ON "cleaning_requests"("commune_key", "status");

-- CreateIndex
CREATE INDEX "cleaning_requests_place_id_idx" ON "cleaning_requests"("place_id");

-- CreateIndex
CREATE INDEX "visit_fees_status_due_at_idx" ON "visit_fees"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "visit_fees_request_id_rank_key" ON "visit_fees"("request_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "visit_fees_id_request_id_key" ON "visit_fees"("id", "request_id");

-- CreateIndex
CREATE INDEX "request_reactivations_request_id_requested_at_idx" ON "request_reactivations"("request_id", "requested_at");

-- CreateIndex
CREATE INDEX "request_reactivations_status_requested_at_idx" ON "request_reactivations"("status", "requested_at");

-- CreateIndex
CREATE INDEX "request_items_offer_id_idx" ON "request_items"("offer_id");

-- CreateIndex
CREATE INDEX "request_items_tariff_version_id_offer_id_idx" ON "request_items"("tariff_version_id", "offer_id");

-- CreateIndex
CREATE INDEX "visits_status_scheduled_start_idx" ON "visits"("status", "scheduled_start");

-- CreateIndex
CREATE INDEX "visits_visit_fee_id_request_id_idx" ON "visits"("visit_fee_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "visits_request_id_attempt_key" ON "visits"("request_id", "attempt");

-- CreateIndex
CREATE INDEX "retained_values_visit_id_idx" ON "retained_values"("visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "retained_values_request_id_revision_key" ON "retained_values"("request_id", "revision");

-- CreateIndex
CREATE INDEX "quotes_status_valid_until_idx" ON "quotes"("status", "valid_until");

-- CreateIndex
CREATE INDEX "quotes_program_id_idx" ON "quotes"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_request_id_version_key" ON "quotes"("request_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "programs_number_key" ON "programs"("number");

-- CreateIndex
CREATE UNIQUE INDEX "programs_quote_id_key" ON "programs"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "programs_renewal_of_program_id_key" ON "programs"("renewal_of_program_id");

-- CreateIndex
CREATE INDEX "programs_owner_kind_owner_id_status_idx" ON "programs"("owner_kind", "owner_id", "status");

-- CreateIndex
CREATE INDEX "programs_status_updated_at_idx" ON "programs"("status", "updated_at");

-- CreateIndex
CREATE INDEX "programs_request_id_idx" ON "programs"("request_id");

-- CreateIndex
CREATE INDEX "program_suspension_causes_program_id_since_idx" ON "program_suspension_causes"("program_id", "since");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_free_redo_of_claim_id_key" ON "sessions"("free_redo_of_claim_id");

-- CreateIndex
CREATE INDEX "sessions_program_id_scheduled_start_idx" ON "sessions"("program_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "sessions_status_commune_key_scheduled_start_idx" ON "sessions"("status", "commune_key", "scheduled_start");

-- CreateIndex
CREATE INDEX "sessions_status_scheduled_start_idx" ON "sessions"("status", "scheduled_start");

-- CreateIndex
CREATE INDEX "sessions_payment_status_payment_due_at_idx" ON "sessions"("payment_status", "payment_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_program_id_rank_key" ON "sessions"("program_id", "rank");

-- CreateIndex
CREATE INDEX "session_incidents_session_id_idx" ON "session_incidents"("session_id");

-- CreateIndex
CREATE INDEX "session_reschedules_session_id_created_at_idx" ON "session_reschedules"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agents_user_id_key" ON "agents"("user_id");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE INDEX "agent_skills_skill_code_status_idx" ON "agent_skills"("skill_code", "status");

-- CreateIndex
CREATE INDEX "agent_zones_commune_key_idx" ON "agent_zones"("commune_key");

-- CreateIndex
CREATE INDEX "availability_rules_agent_id_weekday_idx" ON "availability_rules"("agent_id", "weekday");

-- CreateIndex
CREATE INDEX "unavailabilities_agent_id_starts_at_idx" ON "unavailabilities"("agent_id", "starts_at");

-- CreateIndex
CREATE INDEX "teams_lead_agent_id_idx" ON "teams"("lead_agent_id");

-- CreateIndex
CREATE INDEX "team_members_agent_id_idx" ON "team_members"("agent_id");

-- CreateIndex
CREATE INDEX "assignments_agent_id_occupied_from_idx" ON "assignments"("agent_id", "occupied_from");

-- CreateIndex
CREATE INDEX "assignments_session_id_idx" ON "assignments"("session_id");

-- CreateIndex
CREATE INDEX "assignments_visit_id_idx" ON "assignments"("visit_id");

-- CreateIndex
CREATE INDEX "assignments_status_response_due_at_idx" ON "assignments"("status", "response_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "claims_credit_note_id_key" ON "claims"("credit_note_id");

-- CreateIndex
CREATE INDEX "claims_session_id_idx" ON "claims"("session_id");

-- CreateIndex
CREATE INDEX "claims_status_created_at_idx" ON "claims"("status", "created_at");

-- CreateIndex
CREATE INDEX "claim_messages_claim_id_created_at_idx" ON "claim_messages"("claim_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_operations_idempotency_key_key" ON "wallet_operations"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_operations_request_id_idx" ON "wallet_operations"("request_id");

-- CreateIndex
CREATE INDEX "wallet_operations_visit_fee_id_request_id_idx" ON "wallet_operations"("visit_fee_id", "request_id");

-- CreateIndex
CREATE INDEX "wallet_operations_session_id_idx" ON "wallet_operations"("session_id");

-- CreateIndex
CREATE INDEX "wallet_operations_claim_id_idx" ON "wallet_operations"("claim_id");

-- CreateIndex
CREATE INDEX "wallet_operations_status_created_at_idx" ON "wallet_operations"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "direct_payments_payment_request_id_key" ON "direct_payments"("payment_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "direct_payments_idempotency_key_key" ON "direct_payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "direct_payments_request_id_idx" ON "direct_payments"("request_id");

-- CreateIndex
CREATE INDEX "direct_payments_visit_fee_id_request_id_idx" ON "direct_payments"("visit_fee_id", "request_id");

-- CreateIndex
CREATE INDEX "direct_payments_session_id_idx" ON "direct_payments"("session_id");

-- CreateIndex
CREATE INDEX "direct_payments_status_created_at_idx" ON "direct_payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "organization_invoices_organization_id_standing_idx" ON "organization_invoices"("organization_id", "standing");

-- AddForeignKey
ALTER TABLE "place_types" ADD CONSTRAINT "place_types_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "place_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_types" ADD CONSTRAINT "place_types_area_parameter_id_fkey" FOREIGN KEY ("area_parameter_id") REFERENCES "parameters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_types" ADD CONSTRAINT "cleaning_types_required_skill_code_fkey" FOREIGN KEY ("required_skill_code") REFERENCES "skills"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "cleaning_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "cleaning_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_type_parameters" ADD CONSTRAINT "place_type_parameters_place_type_id_fkey" FOREIGN KEY ("place_type_id") REFERENCES "place_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_type_parameters" ADD CONSTRAINT "place_type_parameters_parameter_id_fkey" FOREIGN KEY ("parameter_id") REFERENCES "parameters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_place_type_id_fkey" FOREIGN KEY ("place_type_id") REFERENCES "place_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_cleaning_type_id_fkey" FOREIGN KEY ("cleaning_type_id") REFERENCES "cleaning_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_parameters" ADD CONSTRAINT "offer_parameters_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_parameters" ADD CONSTRAINT "offer_parameters_parameter_id_fkey" FOREIGN KEY ("parameter_id") REFERENCES "parameters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_base_parameter_id_fkey" FOREIGN KEY ("base_parameter_id") REFERENCES "parameters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_brackets" ADD CONSTRAINT "tariff_brackets_tariff_version_id_fkey" FOREIGN KEY ("tariff_version_id") REFERENCES "tariff_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_supplements" ADD CONSTRAINT "tariff_supplements_tariff_version_id_fkey" FOREIGN KEY ("tariff_version_id") REFERENCES "tariff_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_supplements" ADD CONSTRAINT "tariff_supplements_parameter_id_fkey" FOREIGN KEY ("parameter_id") REFERENCES "parameters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "places" ADD CONSTRAINT "places_place_type_id_fkey" FOREIGN KEY ("place_type_id") REFERENCES "place_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_commune_key_fkey" FOREIGN KEY ("commune_key") REFERENCES "zones"("commune_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_fees" ADD CONSTRAINT "visit_fees_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_reactivations" ADD CONSTRAINT "request_reactivations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_items" ADD CONSTRAINT "request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_items" ADD CONSTRAINT "request_items_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_items" ADD CONSTRAINT "request_items_tariff_version_id_offer_id_fkey" FOREIGN KEY ("tariff_version_id", "offer_id") REFERENCES "tariff_versions"("id", "offer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_visit_fee_id_request_id_fkey" FOREIGN KEY ("visit_fee_id", "request_id") REFERENCES "visit_fees"("id", "request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retained_values" ADD CONSTRAINT "retained_values_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retained_values" ADD CONSTRAINT "retained_values_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_retained_values_id_fkey" FOREIGN KEY ("retained_values_id") REFERENCES "retained_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_commune_key_fkey" FOREIGN KEY ("commune_key") REFERENCES "zones"("commune_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_renewal_of_program_id_fkey" FOREIGN KEY ("renewal_of_program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_suspension_causes" ADD CONSTRAINT "program_suspension_causes_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_commune_key_fkey" FOREIGN KEY ("commune_key") REFERENCES "zones"("commune_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_free_redo_of_claim_id_fkey" FOREIGN KEY ("free_redo_of_claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_incidents" ADD CONSTRAINT "session_incidents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_reschedules" ADD CONSTRAINT "session_reschedules_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_code_fkey" FOREIGN KEY ("skill_code") REFERENCES "skills"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_zones" ADD CONSTRAINT "agent_zones_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_zones" ADD CONSTRAINT "agent_zones_commune_key_fkey" FOREIGN KEY ("commune_key") REFERENCES "zones"("commune_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unavailabilities" ADD CONSTRAINT "unavailabilities_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_lead_agent_id_fkey" FOREIGN KEY ("lead_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_messages" ADD CONSTRAINT "claim_messages_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_visit_fee_id_request_id_fkey" FOREIGN KEY ("visit_fee_id", "request_id") REFERENCES "visit_fees"("id", "request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_payments" ADD CONSTRAINT "direct_payments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cleaning_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_payments" ADD CONSTRAINT "direct_payments_visit_fee_id_request_id_fkey" FOREIGN KEY ("visit_fee_id", "request_id") REFERENCES "visit_fees"("id", "request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_payments" ADD CONSTRAINT "direct_payments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================================
-- Écrit à la main : non exprimable dans schema.prisma.
-- =============================================================================================

ALTER SEQUENCE "cleaning_request_number_seq" OWNED BY "cleaning_requests"."number";
ALTER SEQUENCE "cleaning_program_number_seq" OWNED BY "programs"."number";

-- ---------------------------------------------------------------------------------------------
-- Socle : le relais ne lit que les événements non publiés et non mis de côté, dans l'ordre
-- (index partiels, ADR-032, identiques à la v1).
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "outbox_unpublished_idx" ON "outbox"("created_at", "id") WHERE "published_at" IS NULL AND "parked_at" IS NULL;
CREATE INDEX "outbox_parked_idx" ON "outbox"("parked_at") WHERE "parked_at" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Unicités conditionnelles (index partiels).
-- ---------------------------------------------------------------------------------------------
-- R-CA-07 : une seule version de tarif publiée par offre ; c'est la version en vigueur.
CREATE UNIQUE INDEX "tariff_versions_one_published_idx" ON "tariff_versions"("offer_id") WHERE "status" = 'published';
-- R-DV-05 : un seul devis envoyé (en attente de réponse) par demande ; la révision passe le
-- précédent « superseded » dans la même transaction.
CREATE UNIQUE INDEX "quotes_one_sent_per_request_idx" ON "quotes"("request_id") WHERE "status" = 'sent';
-- Principe « un dossier = un devis accepté » (partie 1) : un seul devis initial (ou de nouvelle
-- commande, R-PG-08, qui ouvre sa propre demande) accepté par demande.
CREATE UNIQUE INDEX "quotes_one_accepted_initial_idx" ON "quotes"("request_id") WHERE "status" = 'accepted' AND "kind" IN ('initial', 'reorder');
-- Principe « un dossier = un programme » : un seul programme d'origine par demande (les
-- renouvellements, R-PG-07, pointent vers le programme renouvelé).
CREATE UNIQUE INDEX "programs_one_initial_per_request_idx" ON "programs"("request_id") WHERE "renewal_of_program_id" IS NULL;
-- Une seule visite planifiée ou en cours à la fois par demande.
CREATE UNIQUE INDEX "visits_one_scheduled_per_request_idx" ON "visits"("request_id") WHERE "status" IN ('scheduled', 'in_progress');
-- R-VI-05, R-FV-03 : un seul frais de visite à payer à la fois par demande.
CREATE UNIQUE INDEX "visit_fees_one_awaiting_per_request_idx" ON "visit_fees"("request_id") WHERE "status" = 'awaiting_payment';
-- R-AC-04 : une seule demande de réactivation en attente par dossier.
CREATE UNIQUE INDEX "request_reactivations_one_pending_idx" ON "request_reactivations"("request_id") WHERE "status" = 'pending';
-- R-CS-03 : une seule révision ouverte (non figée par l'envoi d'un devis) de la version retenue par
-- demande.
CREATE UNIQUE INDEX "retained_values_one_open_idx" ON "retained_values"("request_id") WHERE "locked_at" IS NULL;
-- R-SU-01 : une seule ligne active (non levée) par programme et par cause de suspension.
CREATE UNIQUE INDEX "program_suspension_causes_one_active_idx" ON "program_suspension_causes"("program_id", "cause") WHERE "lifted_at" IS NULL;
-- Un agent n'a qu'une affectation en vigueur (proposée, en attente ou confirmée) sur une même
-- visite ou séance ; un seul chef d'équipe en vigueur par cible (R-EQ-03).
CREATE UNIQUE INDEX "assignments_session_agent_active_idx" ON "assignments"("session_id", "agent_id") WHERE "status" IN ('proposed', 'pending_confirmation', 'confirmed') AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX "assignments_visit_agent_active_idx" ON "assignments"("visit_id", "agent_id") WHERE "status" IN ('proposed', 'pending_confirmation', 'confirmed') AND "visit_id" IS NOT NULL;
CREATE UNIQUE INDEX "assignments_session_lead_idx" ON "assignments"("session_id") WHERE "is_lead" AND "status" IN ('proposed', 'pending_confirmation', 'confirmed') AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX "assignments_visit_lead_idx" ON "assignments"("visit_id") WHERE "is_lead" AND "status" IN ('proposed', 'pending_confirmation', 'confirmed') AND "visit_id" IS NOT NULL;
-- R-PP-01, R-WL-03 : une séance n'est débitée qu'une fois, des frais de visite ne sont débités
-- qu'une fois et remboursés au plus une fois, un crédit de réclamation n'est versé qu'une fois. Une
-- opération en échec (débit remboursé par le rapprochement, refus définitif) ne compte plus : une
-- nouvelle tentative (attempt + 1) est alors possible.
CREATE UNIQUE INDEX "wallet_operations_one_session_payment_idx" ON "wallet_operations"("session_id") WHERE "purpose" = 'session_payment' AND "status" IN ('pending', 'succeeded');
CREATE UNIQUE INDEX "wallet_operations_one_visit_fee_debit_idx" ON "wallet_operations"("visit_fee_id") WHERE "purpose" = 'visit_fee' AND "status" IN ('pending', 'succeeded');
CREATE UNIQUE INDEX "wallet_operations_one_visit_fee_refund_idx" ON "wallet_operations"("visit_fee_id") WHERE "purpose" = 'visit_fee_refund' AND "status" IN ('pending', 'succeeded');
CREATE UNIQUE INDEX "wallet_operations_one_claim_credit_idx" ON "wallet_operations"("claim_id") WHERE "purpose" = 'claim_credit' AND "status" IN ('pending', 'succeeded');
-- Un seul paiement direct en cours par objet : un nouvel appel renvoie la page en cours.
CREATE UNIQUE INDEX "direct_payments_one_pending_session_idx" ON "direct_payments"("session_id") WHERE "status" = 'pending' AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX "direct_payments_one_pending_visit_fee_idx" ON "direct_payments"("visit_fee_id") WHERE "status" = 'pending' AND "visit_fee_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- R-DP-01 : purge des positions par durée de conservation (index partiels de la tâche UC-NT-48).
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "places_purge_idx" ON "places"("archived_at") WHERE "archived_at" IS NOT NULL AND "location_erased_at" IS NULL;
CREATE INDEX "cleaning_requests_purge_idx" ON "cleaning_requests"("closed_at") WHERE "closed_at" IS NOT NULL AND "location_erased_at" IS NULL;
CREATE INDEX "visits_arrival_purge_idx" ON "visits"("request_id") WHERE "arrival_gps_encrypted" IS NOT NULL;
CREATE INDEX "sessions_arrival_purge_idx" ON "sessions"("program_id") WHERE "arrival_gps_encrypted" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Contraintes d'exclusion (GiST, extension btree_gist).
-- ---------------------------------------------------------------------------------------------
-- Partie 9.4, lot D : un agent n'a jamais deux affectations en vigueur dont les périodes occupées
-- (trajet compris) se chevauchent, quel que soit le nombre de superviseurs qui affectent en même
-- temps. Une proposition de la planification (R-PL-05) occupe l'agenda comme une affectation, tant
-- qu'elle n'est ni validée ni retirée (à valider) : la valider ne peut donc pas créer de conflit.
-- Une affectation retirée, refusée ou expirée ne compte plus. Intervalle semi-ouvert : une
-- affectation peut commencer à l'instant où la précédente se termine.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_no_overlap"
  EXCLUDE USING gist ("agent_id" WITH =, tstzrange("occupied_from", "occupied_until", '[)') WITH &&)
  WHERE ("status" IN ('proposed', 'pending_confirmation', 'confirmed'));
-- R-CA-08 : les tranches d'une version de tarif ne se chevauchent pas (bornes entières incluses).
ALTER TABLE "tariff_brackets" ADD CONSTRAINT "tariff_brackets_no_overlap"
  EXCLUDE USING gist ("tariff_version_id" WITH =, int4range("from_value", "to_value", '[]') WITH &&);
-- R-DS-01 : les plages d'un même jour du modèle hebdomadaire ne se chevauchent pas.
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_no_overlap"
  EXCLUDE USING gist ("agent_id" WITH =, "weekday" WITH =, int4range("start_minute", "end_minute", '[)') WITH &&);

-- ---------------------------------------------------------------------------------------------
-- Contraintes CHECK : catalogue (partie 4, 5).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "place_categories" ADD CONSTRAINT "place_categories_visit_fee_check" CHECK ("visit_fee" IS NULL OR "visit_fee" >= 0);
-- R-CA-14 : chaque lieu, sauf « Autre », désigne son paramètre de superficie.
ALTER TABLE "place_types" ADD CONSTRAINT "place_types_area_parameter_check" CHECK ("is_other" OR "area_parameter_id" IS NOT NULL);
ALTER TABLE "cleaning_types" ADD CONSTRAINT "cleaning_types_duration_check" CHECK ("reference_duration_minutes" > 0);
-- R-CA-09 : tout type exige une compétence, sauf un pack (union des compétences de ses types).
ALTER TABLE "cleaning_types" ADD CONSTRAINT "cleaning_types_skill_check" CHECK ("is_pack" OR "required_skill_code" IS NOT NULL);
ALTER TABLE "cleaning_types" ADD CONSTRAINT "cleaning_types_checklist_check" CHECK (jsonb_typeof("checklist_template") = 'array');
ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_not_self_check" CHECK ("pack_id" <> "item_id");
-- R-PX-03 : un nombre est un entier de 0 à 1 000 000.
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_bounds_check" CHECK (
  ("min_value" IS NULL OR "min_value" >= 0)
  AND ("max_value" IS NULL OR "max_value" <= 1000000)
  AND ("min_value" IS NULL OR "max_value" IS NULL OR "min_value" <= "max_value")
);
-- R-CA-11 : l'unité est obligatoire pour un nombre.
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_number_unit_check" CHECK ("kind" <> 'number' OR "unit" IS NOT NULL);
-- R-CA-06 : une valeur de choix se désactive ; un paramètre « choice » garde au moins une valeur active.
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_choices_check" CHECK (
  jsonb_typeof("choices") = 'array' AND ("kind" <> 'choice' OR jsonb_path_exists("choices", '$[*] ? (@.active == true)'))
);
ALTER TABLE "place_type_parameters" ADD CONSTRAINT "place_type_parameters_position_check" CHECK ("position" >= 0);
ALTER TABLE "offer_parameters" ADD CONSTRAINT "offer_parameters_position_check" CHECK ("position" >= 0);
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_version_check" CHECK ("version" >= 1);
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_minimum_price_check" CHECK ("minimum_price" >= 0);
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_published_check" CHECK (
  "status" <> 'published' OR ("published_at" IS NOT NULL AND "published_by" IS NOT NULL)
);
-- R-PX-06 : clés de fréquence weekly, every_N_weeks (N de 2 à 12) et monthly ; coefficients de 1 à
-- 100 000 points de base.
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_frequency_check" CHECK (
  jsonb_typeof("frequency_coefficients") = 'object'
  AND NOT jsonb_path_exists("frequency_coefficients", '$.keyvalue() ? (!(@.key like_regex "^(weekly|monthly|every_([2-9]|1[0-2])_weeks)$") || @.value < 1 || @.value > 100000)')
);
-- R-CA-04 : remise d'un pack de 0 à 90 % ; une version a soit des tranches sur un paramètre de base,
-- soit une remise pack, jamais les deux.
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_pack_discount_check" CHECK (
  "pack_discount_bp" IS NULL OR "pack_discount_bp" BETWEEN 0 AND 9000
);
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_base_or_pack_check" CHECK (
  ("base_parameter_id" IS NULL) <> ("pack_discount_bp" IS NULL)
);
ALTER TABLE "tariff_brackets" ADD CONSTRAINT "tariff_brackets_bounds_check" CHECK ("from_value" >= 0 AND "to_value" >= "from_value");
ALTER TABLE "tariff_brackets" ADD CONSTRAINT "tariff_brackets_amount_check" CHECK ("amount" >= 0);
-- R-PX-02 : coefficients en points de base, plafond × 10.
ALTER TABLE "tariff_supplements" ADD CONSTRAINT "tariff_supplements_value_check" CHECK (
  ("mode" = 'coefficient' AND "amount" IS NULL AND "coefficient_bp" BETWEEN 1 AND 100000)
  OR ("mode" <> 'coefficient' AND "coefficient_bp" IS NULL AND "amount" IS NOT NULL AND "amount" >= 0)
);
ALTER TABLE "tariff_supplements" ADD CONSTRAINT "tariff_supplements_included_units_check" CHECK ("included_units" BETWEEN 0 AND 1000000);
ALTER TABLE "zones" ADD CONSTRAINT "zones_coefficient_check" CHECK ("coefficient_bp" BETWEEN 1 AND 100000);
ALTER TABLE "zones" ADD CONSTRAINT "zones_visit_fee_surcharge_check" CHECK ("visit_fee_surcharge" IS NULL OR "visit_fee_surcharge" >= 0);

-- ---------------------------------------------------------------------------------------------
-- Contraintes CHECK : lieux, demandes, visites, devis (parties 3, 7, 16.3).
-- ---------------------------------------------------------------------------------------------
-- Partie 16.3, R-DP-01, R-DP-02 : une position effacée l'est entièrement (position, repère, adresse
-- saisie et adresse lisible) ; tant qu'elle ne l'est pas, la position et le repère sont présents.
ALTER TABLE "places" ADD CONSTRAINT "places_location_erased_check" CHECK (
  "location_erased_at" IS NULL
  OR ("gps_encrypted" IS NULL AND "landmark_encrypted" IS NULL AND "address_encrypted" IS NULL AND "readable_address_encrypted" IS NULL)
);
ALTER TABLE "places" ADD CONSTRAINT "places_location_present_check" CHECK (
  "location_erased_at" IS NOT NULL OR ("gps_encrypted" IS NOT NULL AND "landmark_encrypted" IS NOT NULL)
);
ALTER TABLE "places" ADD CONSTRAINT "places_declared_values_check" CHECK (jsonb_typeof("declared_values") = 'object');
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_number_check" CHECK ("number" ~ '^DN-[0-9]{6,}$');
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_amounts_check" CHECK (
  "estimated_session_price" IS NULL OR "estimated_session_price" >= 0
);
-- Partie 7.1 : 1 à 3 créneaux de visite, 5 photos au plus.
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_visit_slots_check" CHECK (
  jsonb_typeof("visit_slots") = 'array' AND jsonb_array_length("visit_slots") BETWEEN 1 AND 3
);
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_photos_check" CHECK (cardinality("photo_file_ids") <= 5);
-- R-DM-08 : copie chiffrée de la position du lieu, présente jusqu'à son effacement complet.
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_location_erased_check" CHECK (
  "location_erased_at" IS NULL
  OR ("gps_encrypted" IS NULL AND "landmark_encrypted" IS NULL AND "address_encrypted" IS NULL AND "readable_address_encrypted" IS NULL)
);
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_location_present_check" CHECK (
  "location_erased_at" IS NOT NULL OR ("gps_encrypted" IS NOT NULL AND "landmark_encrypted" IS NOT NULL)
);
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_declared_rows_check" CHECK (jsonb_typeof("declared_rows") = 'array');
-- Motif codé d'une annulation par le client ou d'un refus par KSP ; un refus porte son motif.
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_closing_reason_code_check" CHECK (
  "closing_reason_code" IS NULL
  OR "closing_reason_code" IN ('no_longer_needed', 'found_other_provider', 'visit_fee', 'other', 'place_inaccessible', 'service_impossible')
);
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_rejected_check" CHECK (
  "status" <> 'rejected' OR ("closing_reason" IS NOT NULL AND "closing_reason_code" IS NOT NULL)
);
-- Partie 7.2 : frais de visite. Montant >= 0 ; des frais sortis de « à payer » ont été payés ; un
-- remboursement est daté.
ALTER TABLE "visit_fees" ADD CONSTRAINT "visit_fees_rank_check" CHECK ("rank" >= 1);
ALTER TABLE "visit_fees" ADD CONSTRAINT "visit_fees_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "visit_fees" ADD CONSTRAINT "visit_fees_paid_check" CHECK ("status" = 'awaiting_payment' OR "paid_at" IS NOT NULL);
ALTER TABLE "visit_fees" ADD CONSTRAINT "visit_fees_refunded_check" CHECK (("status" = 'refunded') = ("refunded_at" IS NOT NULL));
-- R-AC-04 : une décision de réactivation est datée et signée ; une demande en attente n'en a pas.
ALTER TABLE "request_reactivations" ADD CONSTRAINT "request_reactivations_decision_check" CHECK (
  ("status" = 'pending') = ("decided_at" IS NULL) AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
);
ALTER TABLE "visits" ADD CONSTRAINT "visits_attempt_check" CHECK ("attempt" >= 1);
ALTER TABLE "visits" ADD CONSTRAINT "visits_period_check" CHECK ("scheduled_end" > "scheduled_start" AND "duration_minutes" > 0);
-- R-VI-04 : 10 photos au plus.
ALTER TABLE "visits" ADD CONSTRAINT "visits_photos_check" CHECK (cardinality("photo_file_ids") <= 10);
ALTER TABLE "visits" ADD CONSTRAINT "visits_arrival_distance_check" CHECK ("arrival_distance_m" IS NULL OR "arrival_distance_m" >= 0);
-- R-VI-05 : « manquée » est toujours une absence du client : datée, avec la photo du lieu, sauf
-- absence signalée par le back-office (R-VI-08).
ALTER TABLE "visits" ADD CONSTRAINT "visits_missed_check" CHECK (
  ("status" = 'missed') = ("missed_at" IS NOT NULL)
  AND ("status" <> 'missed' OR "missed_photo_file_id" IS NOT NULL OR "closed_by_staff")
);
-- R-VI-06 : une visite annulée porte son heure et sa cause, et seulement elle.
ALTER TABLE "visits" ADD CONSTRAINT "visits_cancelled_check" CHECK (
  ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
  AND ("status" = 'cancelled') = ("cancel_cause" IS NOT NULL)
);
ALTER TABLE "visits" ADD CONSTRAINT "visits_observed_rows_check" CHECK (jsonb_typeof("observed_rows") = 'array');
ALTER TABLE "visits" ADD CONSTRAINT "visits_observation_note_check" CHECK (
  "observation_note" IS NULL OR char_length("observation_note") <= 1000
);
-- R-VI-08 : une clôture par le back-office porte son auteur et son motif.
ALTER TABLE "visits" ADD CONSTRAINT "visits_staff_close_check" CHECK (
  NOT "closed_by_staff" OR ("closed_by" IS NOT NULL AND "closed_reason" IS NOT NULL)
);
ALTER TABLE "retained_values" ADD CONSTRAINT "retained_values_rows_check" CHECK (jsonb_typeof("rows") = 'array');
-- R-CS-03 : révisions numérotées à partir de 1 ; à partir de la deuxième, un motif est obligatoire.
ALTER TABLE "retained_values" ADD CONSTRAINT "retained_values_revision_check" CHECK (
  "revision" >= 1 AND ("revision" = 1 OR "reason" IS NOT NULL)
);
ALTER TABLE "visits" ADD CONSTRAINT "visits_completed_check" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_version_check" CHECK ("version" >= 1);
-- R-DV-03 : le prix d'une séance reste strictement positif.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_session_price_check" CHECK ("session_price" > 0);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_amounts_check" CHECK ("total" >= 0 AND "visit_fee_deduction" >= 0);
-- Partie 5 : prix du programme = prix d'une séance × nombre de séances.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_total_check" CHECK ("sessions_count" >= 1 AND "total" = "session_price" * "sessions_count");
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_team_check" CHECK ("team_size" >= 1 AND "duration_minutes" > 0);
-- R-DV-03 : une remise ou une majoration manuelle porte son motif.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_adjustment_reason_check" CHECK (
  "manual_adjustment" IS NULL OR "manual_adjustment" = 0 OR "manual_adjustment_reason" IS NOT NULL
);
-- Un avenant ou un renouvellement vise un programme ; un devis initial ou de nouvelle commande
-- (R-PG-08, nouvelle demande) n'en vise aucun (à valider).
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_program_check" CHECK (("kind" IN ('initial', 'reorder')) = ("program_id" IS NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_sent_check" CHECK (
  "status" = 'draft' OR ("sent_at" IS NOT NULL AND "valid_until" IS NOT NULL)
);
-- R-VI-07 : un devis retiré porte la date et le motif du retrait.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_withdrawn_check" CHECK (
  "status" <> 'withdrawn' OR ("withdrawn_at" IS NOT NULL AND "withdrawal_reason" IS NOT NULL)
);

-- ---------------------------------------------------------------------------------------------
-- Contraintes CHECK : programmes et séances (parties 8, 10, 11, 12).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "programs" ADD CONSTRAINT "programs_number_check" CHECK ("number" ~ '^PN-[0-9]{6,}$');
ALTER TABLE "programs" ADD CONSTRAINT "programs_amounts_check" CHECK ("session_price" > 0 AND "visit_fee_to_deduct" >= 0);
ALTER TABLE "programs" ADD CONSTRAINT "programs_team_check" CHECK ("team_size" >= 1 AND "duration_minutes" > 0);
-- Partie 11 : un particulier paie séance par séance, une organisation par facture mensuelle.
ALTER TABLE "programs" ADD CONSTRAINT "programs_payer_check" CHECK (("owner_kind" = 'user') = ("payer_kind" = 'individual'));
-- R-SU-01 : suspendu tant qu'une cause reste active, et seulement dans ce cas (hors statuts finaux).
ALTER TABLE "programs" ADD CONSTRAINT "programs_suspension_check" CHECK (
  "status" IN ('completed', 'cancelled')
  OR ("status" = 'suspended') = (cardinality("suspension_causes") > 0)
);
-- R-SU-01 : une suspension décidée par KSP porte son motif et son auteur (historique des causes).
ALTER TABLE "program_suspension_causes" ADD CONSTRAINT "program_suspension_causes_ksp_check" CHECK (
  "cause" <> 'ksp_decision' OR ("reason" IS NOT NULL AND "decided_by" IS NOT NULL)
);
-- R-DP-01 : la fin d'un programme est datée (départ de la conservation des positions).
ALTER TABLE "programs" ADD CONSTRAINT "programs_completed_check" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL);
-- Partie 12 : un arrêt par KSP porte son motif.
ALTER TABLE "programs" ADD CONSTRAINT "programs_cancellation_check" CHECK (
  ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL)
  AND ("cancelled_by" IS DISTINCT FROM 'ksp' OR "cancellation_reason" IS NOT NULL)
);
ALTER TABLE "programs" ADD CONSTRAINT "programs_renewal_check" CHECK ("renewal_of_program_id" IS NULL OR "renewal_of_program_id" <> "id");
-- R-PG-07 : une proposition de renouvellement est datée ; une réponse (acceptée ou refusée) aussi.
ALTER TABLE "programs" ADD CONSTRAINT "programs_renewal_status_check" CHECK (
  ("renewal_status" IS NULL) = ("renewal_proposed_at" IS NULL)
  AND ("renewal_status" IS NOT NULL AND "renewal_status" IN ('accepted', 'declined')) = ("renewal_responded_at" IS NOT NULL)
  AND ("renewal_responded_at" IS NULL) = ("renewal_responded_by" IS NULL)
);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rank_check" CHECK ("rank" >= 1);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_period_check" CHECK ("scheduled_end" > "scheduled_start");
-- Montants : prix >= 0 (0 pour une repasse gratuite), montant dû entre 0 et le prix, déduction des
-- frais de visite au plus égale au montant dû.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_amounts_check" CHECK (
  "price" >= 0
  AND ("amount_due" IS NULL OR "amount_due" BETWEEN 0 AND "price")
  AND "visit_fee_deducted" >= 0
  AND "visit_fee_deducted" <= COALESCE("amount_due", "price")
);
-- R-RC-03 : une repasse gratuite est une séance à 0 FCFA.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_free_redo_check" CHECK ("free_redo_of_claim_id" IS NULL OR "price" = 0);
-- Partie 10 : note de 1 à 5 étoiles.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_arrival_distance_check" CHECK ("arrival_distance_m" IS NULL OR "arrival_distance_m" >= 0);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_started_check" CHECK (
  "status" NOT IN ('in_progress', 'interrupted', 'completed') OR "started_at" IS NOT NULL
);
-- R-EX-08 : une clôture par le back-office porte son auteur, son motif et au moins un agent présent.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_close_check" CHECK (
  NOT "closed_by_staff"
  OR ("closed_by" IS NOT NULL AND "closed_reason" IS NOT NULL AND cardinality("present_agent_ids") >= 1)
);
-- Partie 10 : une séance réalisée a au moins une photo « avant » et une photo « après », sauf clôture
-- par le back-office (R-EX-08).
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_completed_check" CHECK (
  "status" <> 'completed'
  OR ("completed_at" IS NOT NULL AND ("closed_by_staff" OR (cardinality("before_photo_file_ids") >= 1 AND cardinality("after_photo_file_ids") >= 1)))
);
-- R-EX-02 : une séance manquée porte sa cause, son heure et la photo du lieu ; client absent : avec
-- le début de l'attente et l'appel tracé (l'attente réglée est contrôlée par le domaine). Photo,
-- attente et appel sont dispensés pour une absence signalée par le back-office (R-EX-08).
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_missed_check" CHECK (
  ("status" = 'missed') = ("missed_cause" IS NOT NULL)
  AND ("status" <> 'missed' OR ("missed_at" IS NOT NULL AND ("missed_photo_file_id" IS NOT NULL OR "closed_by_staff")))
  AND ("missed_cause" IS DISTINCT FROM 'customer_absent' OR "closed_by_staff" OR ("wait_started_at" IS NOT NULL AND "called_at" IS NOT NULL))
);
-- R-PL-10 : une séance annulée porte son heure et sa cause, et seulement elle.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cancelled_check" CHECK (
  ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
  AND ("status" = 'cancelled') = ("cancel_cause" IS NOT NULL)
);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_paid_check" CHECK ("payment_status" <> 'paid' OR "paid_at" IS NOT NULL);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_checklist_check" CHECK (jsonb_typeof("checklist") = 'array');
-- Partie 10 : une décision sur un incident est datée et signée ; un incident en attente n'en a pas.
ALTER TABLE "session_incidents" ADD CONSTRAINT "session_incidents_decision_check" CHECK (
  ("decision" = 'pending') = ("decided_at" IS NULL) AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
);
ALTER TABLE "session_reschedules" ADD CONSTRAINT "session_reschedules_period_check" CHECK (
  "previous_end" > "previous_start" AND "new_end" > "new_start"
);

-- ---------------------------------------------------------------------------------------------
-- Contraintes CHECK : agents et planification (partie 9).
-- ---------------------------------------------------------------------------------------------
-- R-DS-03 : charge maximale par jour et par semaine.
ALTER TABLE "agents" ADD CONSTRAINT "agents_max_hours_check" CHECK (
  "max_hours_day" BETWEEN 1 AND 24 AND "max_hours_week" BETWEEN 1 AND 168 AND "max_hours_day" <= "max_hours_week"
);
ALTER TABLE "agents" ADD CONSTRAINT "agents_rating_check" CHECK (
  "rating_count" >= 0 AND "rating_sum" BETWEEN "rating_count" AND 5 * "rating_count"
);
-- Partie 9.1 : un refus porte son motif.
ALTER TABLE "agents" ADD CONSTRAINT "agents_rejected_reason_check" CHECK ("status" <> 'rejected' OR "status_reason" IS NOT NULL);
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_period_check" CHECK (
  "weekday" BETWEEN 1 AND 7 AND "start_minute" >= 0 AND "start_minute" < "end_minute" AND "end_minute" <= 1440
);
ALTER TABLE "unavailabilities" ADD CONSTRAINT "unavailabilities_period_check" CHECK ("ends_at" > "starts_at");
-- Partie 9.4 : une affectation vise une visite ou une séance, jamais les deux.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_target_check" CHECK (
  ("target_kind" = 'visit' AND "visit_id" IS NOT NULL AND "session_id" IS NULL)
  OR ("target_kind" = 'session' AND "session_id" IS NOT NULL AND "visit_id" IS NULL)
);
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_period_check" CHECK (
  "occupied_until" > "occupied_from" AND "travel_minutes" >= 0
);
-- Partie 9.4 : un contrôle contournable n'est forcé qu'avec un motif.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_override_reason_check" CHECK (
  cardinality("overrides") = 0 OR "reason" IS NOT NULL
);
-- Partie 9.5 : une affectation manuelle porte son auteur (null seulement pour l'automatique).
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_check" CHECK ("source" = 'auto' OR "created_by" IS NOT NULL);
-- R-PL-08 : une affectation en attente de l'indépendant a une échéance de réponse.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_response_due_check" CHECK (
  "status" <> 'pending_confirmation' OR "response_due_at" IS NOT NULL
);
-- R-PL-05 : une proposition n'est pas encore validée ; une validation est datée et signée.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_approval_check" CHECK (
  ("approved_at" IS NULL) = ("approved_by" IS NULL) AND ("status" <> 'proposed' OR "approved_at" IS NULL)
);
-- UC-NT-37 : un retrait est daté et motivé ; seule une affectation retirée l'est.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_removal_check" CHECK (
  ("status" = 'removed') = ("removed_at" IS NOT NULL)
  AND ("status" <> 'removed' OR "removal_reason" IS NOT NULL)
);

-- ---------------------------------------------------------------------------------------------
-- Contraintes CHECK : réclamations et argent (parties 11, 12, R-WL-03).
-- ---------------------------------------------------------------------------------------------
-- R-RC-03 : crédit positif pour un crédit au wallet (avoir pour une entreprise) ; au-delà de
-- 50 000 FCFA, validé par une deuxième personne.
ALTER TABLE "claims" ADD CONSTRAINT "claims_credit_check" CHECK (
  ("credit_amount" IS NULL OR "credit_amount" >= 0)
  AND ("decision" IS DISTINCT FROM 'wallet_credit' OR ("credit_amount" IS NOT NULL AND "credit_amount" > 0))
  AND ("credit_note_id" IS NULL OR "decision" = 'wallet_credit')
);
ALTER TABLE "claims" ADD CONSTRAINT "claims_credit_approval_check" CHECK (
  "credit_amount" IS NULL OR "credit_amount" <= 50000
  OR ("credit_approved_by" IS NOT NULL AND "credit_approved_by" IS DISTINCT FROM "decided_by")
);
-- R-RC-02 : décision motivée ; une réclamation close porte sa décision.
ALTER TABLE "claims" ADD CONSTRAINT "claims_decision_check" CHECK (
  ("decision" IS NULL OR ("decision_reason" IS NOT NULL AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL))
  AND ("status" NOT IN ('resolved', 'rejected') OR ("decision" IS NOT NULL AND "closed_at" IS NOT NULL))
);
-- R-WL-03 : montant positif ; l'objet fixe le sens et le dossier concerné.
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_amount_check" CHECK ("amount" > 0);
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_purpose_check" CHECK (
  ("purpose" = 'visit_fee' AND "kind" = 'debit' AND "request_id" IS NOT NULL AND "visit_fee_id" IS NOT NULL)
  OR ("purpose" = 'visit_fee_refund' AND "kind" = 'credit' AND "request_id" IS NOT NULL AND "visit_fee_id" IS NOT NULL)
  OR ("purpose" = 'session_payment' AND "kind" = 'debit' AND "session_id" IS NOT NULL)
  OR ("purpose" = 'claim_credit' AND "kind" = 'credit' AND "claim_id" IS NOT NULL)
  OR ("purpose" = 'commercial_gesture' AND "kind" = 'credit' AND "created_by" IS NOT NULL)
);
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_completed_check" CHECK (
  "status" = 'pending' OR "completed_at" IS NOT NULL
);
ALTER TABLE "wallet_operations" ADD CONSTRAINT "wallet_operations_attempt_check" CHECK ("attempt" >= 1);
ALTER TABLE "direct_payments" ADD CONSTRAINT "direct_payments_amount_check" CHECK ("amount" > 0);
ALTER TABLE "direct_payments" ADD CONSTRAINT "direct_payments_target_check" CHECK (
  ("purpose" = 'visit_fee' AND "request_id" IS NOT NULL AND "visit_fee_id" IS NOT NULL)
  OR ("purpose" = 'session_payment' AND "session_id" IS NOT NULL)
);
-- R-PE-06 : compte des impayés et niveau d'avertissement d'une organisation.
ALTER TABLE "organization_billing_standings" ADD CONSTRAINT "organization_billing_standings_counts_check" CHECK (
  "overdue_count" >= 0 AND "warning_level" >= 0
);

-- ---------------------------------------------------------------------------------------------
-- Réglages (partie 16.1) : une seule ligne, chaque valeur dans ses bornes.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "cleaning_settings" ADD CONSTRAINT "cleaning_settings_singleton" CHECK ("id" = 1);
ALTER TABLE "cleaning_settings" ADD CONSTRAINT "cleaning_settings_bounds_check" CHECK (
  "max_open_requests" BETWEEN 1 AND 100
  AND "min_visit_lead_hours" BETWEEN 0 AND 168
  AND "visit_fee_payment_hours" BETWEEN 1 AND 168
  AND "visit_target_hours" BETWEEN 24 AND 240
  AND "visit_duration_minutes" BETWEEN 15 AND 480
  AND "default_travel_minutes" BETWEEN 0 AND 120
  AND "default_visit_fee" >= 0
  AND "quote_validity_days" BETWEEN 1 AND 90
  AND "quote_reminder_days" BETWEEN 0 AND 30
  AND ("quote_reminder_days" = 0 OR "quote_reminder_days" < "quote_validity_days")
  AND "max_discount_without_approval_pct" BETWEEN 0 AND 100
  AND "first_session_lead_hours" BETWEEN 0 AND 720
  AND "program_max_months" BETWEEN 1 AND 60
  AND "program_max_sessions" BETWEEN 1 AND 1000
  AND "free_cancellation_hours" BETWEEN 0 AND 168
  AND "max_reschedules_per_month" BETWEEN 0 AND 10
  AND "late_cancellation_fee_pct" BETWEEN 0 AND 100
  AND "session_payment_grace_hours" BETWEEN 1 AND 168
  AND "overdue_sessions_before_suspension" BETWEEN 1 AND 10
  AND "unpaid_invoices_warning" BETWEEN 1 AND 12
  AND "unpaid_invoices_suspension" BETWEEN 1 AND 12
  AND "unpaid_invoices_warning" < "unpaid_invoices_suspension"
  AND "planning_horizon_days" BETWEEN 1 AND 60
  AND "assignment_response_hours" BETWEEN 1 AND 72
  AND "default_max_hours_day" BETWEEN 1 AND 24
  AND "default_max_hours_week" BETWEEN 1 AND 168
  AND "default_max_hours_day" <= "default_max_hours_week"
  AND "max_photos_per_type" BETWEEN 1 AND 50
  AND "claim_window_hours" BETWEEN 12 AND 168
  AND "retention_months" BETWEEN 1 AND 120
  AND "arrival_alert_meters" BETWEEN 50 AND 5000
  AND "arrival_max_advance_minutes" BETWEEN 0 AND 240
  AND "customer_wait_minutes" BETWEEN 10 AND 120
);
-- R-EX-09 : points communs de la liste de contrôle, 50 au plus.
ALTER TABLE "cleaning_settings" ADD CONSTRAINT "cleaning_settings_common_checklist_check" CHECK (
  jsonb_typeof("common_checklist") = 'array' AND jsonb_array_length("common_checklist") <= 50
);
-- R-PL-03 : poids du score entre 0 et 100, total = 100.
ALTER TABLE "cleaning_settings" ADD CONSTRAINT "cleaning_settings_score_weights_check" CHECK (
  "score_weight_continuity" BETWEEN 0 AND 100
  AND "score_weight_proximity" BETWEEN 0 AND 100
  AND "score_weight_balance" BETWEEN 0 AND 100
  AND "score_weight_rating" BETWEEN 0 AND 100
  AND "score_weight_continuity" + "score_weight_proximity" + "score_weight_balance" + "score_weight_rating" = 100
);
INSERT INTO "cleaning_settings" ("id") VALUES (1);
