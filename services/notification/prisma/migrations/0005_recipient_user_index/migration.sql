-- ADR-036 : à l'anonymisation d'un compte (identity.user.deleted), ses envois sont retrouvés par
-- recipient_user_id pour être détachés, sans parcourir toute la table.

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_idx" ON "notifications"("recipient_user_id");
