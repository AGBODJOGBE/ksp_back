-- Piste A (agents), R-AG-02 : invitation d'un agent par l'admin Nettoyage. Le numéro invité n'est
-- jamais en clair : chiffré par le chiffrement de champs du service, et retrouvé par une empreinte à
-- clé (jamais un simple condensé du numéro). Le numéro chiffré est effacé quand l'invitation est
-- consommée. Ajout seulement.
CREATE TABLE "agent_invitations" (
    "id" UUID NOT NULL,
    "phone_encrypted" TEXT,
    "phone_fingerprint" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(3),
    "agent_id" UUID,

    CONSTRAINT "agent_invitations_pkey" PRIMARY KEY ("id")
);

-- Un numéro n'a qu'une invitation en cours : inviter de nouveau la renouvelle. Index partiel, absent
-- du schéma Prisma (qui ne sait pas l'écrire).
CREATE UNIQUE INDEX "agent_invitations_open_phone_key" ON "agent_invitations"("phone_fingerprint") WHERE "consumed_at" IS NULL;
