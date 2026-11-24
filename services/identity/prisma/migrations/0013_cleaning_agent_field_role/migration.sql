-- R-RB-07 (CDC Nettoyage v2) : cleaning_agent est un rôle de terrain. L'agent se connecte à
-- l'application agent par code et appareil enregistré : ni back-office, ni application
-- d'authentification. La migration 0004 l'avait enregistré avec les deux : erreur corrigée ici.
-- Les colonnes de modification (updated_at, updated_by) ne sont pas touchées : le rôle reste un rôle
-- livré par défaut jamais modifié par un administrateur.
UPDATE "roles" SET "requires_mfa" = false, "backoffice_access" = false WHERE "code" = 'cleaning_agent';
