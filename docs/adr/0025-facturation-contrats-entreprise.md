# ADR-025 — Facturation minimale des contrats d'entreprise : contrats appris par événements, mois civils au prorata

**Statut** : Accepté (lot 2 ; règles de facturation tranchées le 2026-10-23)

## Contexte

Le cahier des charges Nettoyage (partie 10, décidée le 2026-10-23) impose une facture mensuelle pour les entreprises, une échéance réglable (10 jours), un avertissement dès 1 facture impayée, une suspension à 2 impayées et un déblocage au règlement. Le service `billing` arrive donc au lot 2, en version minimale. Il a besoin du montant, de la durée et du début de chaque contrat, qui vivent dans la base de `cleaning` ; la règle d'or n° 1 interdit de la lire.

## Décision

1. **Contrats appris par événements**, pas par appel gRPC : `billing` consomme `cleaning.booking.confirmed` (missions d'une organisation), `cleaning.request.cancelled`, `cleaning.contract.suspended` et `cleaning.contract.resumed`, et garde sa propre table `billing_contracts`. `cleaning.booking.confirmed` reçoit par ajout le champ facultatif `startsAt` (début du créneau choisi). Raisons : la facturation planifiée ne dépend pas de la disponibilité de `cleaning` ; aucune chaîne d'appels (règle d'or n° 5) ; l'événement était déjà prévu pour `billing` dans la carte des services.
2. **Une facture par mois civil**, à l'heure du Bénin (UTC+1, sans heure d'été), **émise à la fin du mois : le 1er du mois suivant à 00:00, heure du Bénin** (au premier passage de la tâche planifiée). Échéance = émission + délai réglable (10 jours par défaut).
3. **Prorata des jours** : montant mensuel (`total / durée`, en valeur exacte) × jours facturables / jours du mois, arrondi à l'entier de FCFA. Le premier et le dernier mois partiels sont proratisés ; les jours de suspension (de la date de suspension, incluse, à celle de la reprise, exclue) sont déduits de la même façon, suspension en cours comprise. Le **dernier mois du contrat absorbe l'écart d'arrondi** : hors suspension, la somme des factures vaut exactement le total. Un contrat annulé est facturé jusqu'au jour de l'annulation (exclu), sans absorption. Un mois entièrement suspendu ne donne pas de facture.
4. **Tâche planifiée interne** (15 minutes) : émission puis passage en `overdue` à l'échéance, idempotents (unicité contrat + mois, transitions conditionnelles, verrou du contrat). Numérotation `FAC-<année>-<000001>` tirée d'un compteur dans la transaction de l'émission : aucun trou.
5. **Impayés suivis par cleaning** : `cleaning` consomme `billing.invoice.overdue` et `billing.invoice.paid` et tient sa propre liste des factures impayées par mission (inbox ; une facture payée ne redevient jamais impayée, quel que soit l'ordre d'arrivée). Les seuils d'avertissement et de suspension sont des réglages de `cleaning` ; le délai de règlement est un réglage de `billing`. Une mission d'entreprise se règle par ses factures : le paiement manuel de `cleaning` est réservé aux particuliers.

## Conséquences

- Une suspension annoncée après l'émission de la facture du mois n'est pas déduite de cette facture (pas d'avoir au lot 2).
- Les factures d'un contrat sont plus nombreuses que sa durée en mois quand il ne commence pas le 1er (premier et dernier mois partiels).

## Alternatives écartées

- **Appel gRPC de `billing` vers `cleaning`** à chaque émission : couplage temporel, panne de `cleaning` = factures en retard.
- **Mois glissants depuis le début du contrat** : moins lisible pour l'entreprise et pour la comptabilité (une facture à cheval sur deux mois civils).
- **Mois terminé pendant une suspension non facturé** (première proposition) : remplacé par le prorata des jours, plus juste dans les deux sens.
- **Compte des impayés porté par les événements de `billing`** (`overdueCount`) comme seule source : sensible à l'ordre d'arrivée des messages ; le champ reste publié à titre d'information (notifications).
