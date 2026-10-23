-- Environnement local uniquement : une base et un utilisateur par service (règle d'or n° 1).
-- Le générateur de service ajoute ses lignes à la fin de ce fichier.
-- Mots de passe de développement : jamais utilisés ailleurs qu'en local.
-- CREATEDB : « prisma migrate dev » crée une base temporaire (shadow database) pour vérifier les migrations.

CREATE USER identity WITH PASSWORD 'identity' CREATEDB;
CREATE DATABASE identity OWNER identity;

CREATE USER notification WITH PASSWORD 'notification' CREATEDB;
CREATE DATABASE notification OWNER notification;

CREATE USER cleaning WITH PASSWORD 'cleaning' CREATEDB;
CREATE DATABASE cleaning OWNER cleaning;
