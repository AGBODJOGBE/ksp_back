-- ADR-048 : empreinte (HMAC-SHA256 à clé secrète) du numéro complet du bénéficiaire, gardée après la
-- transmission à payment : le rejeu d'une demande est jugé sur elle, plus sur le numéro masqué.
-- Reversements existants : null (comparés comme avant).
ALTER TABLE "wallet_payouts" ADD COLUMN "beneficiary_phone_hash" TEXT;
ALTER TABLE "wallet_payouts" ADD CONSTRAINT "wallet_payouts_phone_hash_check"
  CHECK ("beneficiary_phone_hash" IS NULL OR "beneficiary_phone_hash" ~ '^[0-9a-f]{64}$');
