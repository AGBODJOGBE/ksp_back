-- ADR-036 : suppression du compte (UC-ID-11). Le compte est gelé (deletion_pending) jusqu'à la date
-- prévue, fixée à la demande ; à l'échéance, une tâche planifiée recontrôle les obligations puis
-- anonymise le compte. Un report (obligation apparue entre-temps) garde la date du contrôle et les
-- raisons trouvées.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "deletion_scheduled_for" TIMESTAMPTZ(3),
ADD COLUMN "deletion_checked_at" TIMESTAMPTZ(3),
ADD COLUMN "deletion_postponed_by" JSONB;

-- CreateIndex
CREATE INDEX "users_status_deletion_scheduled_for_idx" ON "users"("status", "deletion_scheduled_for");
