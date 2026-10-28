-- Filtres de la liste des demandes du back-office et idempotence du paiement manuel.

-- Code de zone de la commune saisie (même clé que zoneCode : minuscules, sans accents, tirets),
-- pour filtrer les demandes par zone. Rattrapage des demandes existantes : les lettres accentuées
-- courantes sont remplacées par leur lettre de base, comme le fait la normalisation du service.
ALTER TABLE "quote_requests" ADD COLUMN "commune_code" TEXT;

UPDATE "quote_requests"
SET "commune_code" = regexp_replace(
    translate(
        lower(regexp_replace("commune", '^[[:space:]]+|[[:space:]]+$', '', 'g')),
        'àáâãäåāăąçćĉċčďèéêëēĕėęěìíîïĩīĭįñńņňòóôõöōŏőùúûüũūŭůűųýÿŷŕřŗśŝşšţťźżžĝğġģĥĵķĺļľŵ',
        'aaaaaaaaacccccdeeeeeeeeeiiiiiiiinnnnoooooooouuuuuuuuuuyyyrrrssssttzzzgggghjklllw'
    ),
    '[[:space:]_]+', '-', 'g'
);

ALTER TABLE "quote_requests" ALTER COLUMN "commune_code" SET NOT NULL;

CREATE INDEX "quote_requests_commune_code_id_idx" ON "quote_requests"("commune_code", "id");

-- Clé d'idempotence du paiement manuel (en-tête Idempotency-Key, facultatif) : un même envoi
-- n'enregistre qu'un paiement par mission. Les paiements sans clé (NULL) ne sont pas concernés.
ALTER TABLE "mission_payments" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "mission_payments_mission_id_idempotency_key_key" ON "mission_payments"("mission_id", "idempotency_key");
