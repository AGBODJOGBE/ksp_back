-- Piste A (agents), R-AG-01 (ADR-057, décision 8) : attribution du rôle cleaning_agent rendue par
-- identity.GrantRole. RevokeRole retire une attribution par son identifiant, jamais par le compte :
-- il faut donc le garder. Posé quand l'agent devient actif, gardé pendant une suspension, effacé une
-- fois le rôle retiré après la désactivation. Ajout seulement.
ALTER TABLE "agents" ADD COLUMN "role_assignment_id" UUID;
