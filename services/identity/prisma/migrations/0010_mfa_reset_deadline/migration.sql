-- ADR-050 : après une réinitialisation de la double authentification, la reconfiguration n'est
-- ouverte que jusqu'à cette échéance ; levée quand l'application est de nouveau confirmée.
ALTER TABLE "users" ADD COLUMN "mfa_enrollment_deadline" TIMESTAMPTZ(3);
