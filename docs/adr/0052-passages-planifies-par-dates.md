# ADR-052 — Passages planifiés par dates, récurrence en option

**Statut** : Proposé (décision du responsable, 2026-11-10)

## Contexte

Le responsable a demandé : « Pour la planification des passages, je propose que ce soient des dates. La
récurrence est une option où l'on définit aussi la période (de janvier à décembre) ou des semaines. Quand
le client choisit les passages (lundi, mercredi et samedi), il peut dire que c'est récurrent chaque
semaine ou chaque mois sur la période (10/11/2026 au 11/11/2027). Routes bien claires pour faciliter
l'intégration. »

Jusqu'ici, un contrat récurrent (ADR-023) était décrit par `recurrence { period, visitsPerPeriod,
durationMonths }` et le nombre de passages était approché (52/12 semaines par mois) : un contrat « chaque
lundi pendant 12 mois » comptait 52 passages, qu'il y ait 52 ou 53 lundis. Le prix (prix d'un passage ×
nombre de passages), l'acompte et le suivi des impayés reposaient sur cette approximation, et aucune
date n'était connue avant la planification par la supervision.

## Décision

1. **Un plan de passages (`schedule`) remplace la récurrence approximative.** Le moteur
   (`services/cleaning/src/domain/intervention-schedule.ts`, pur et testé) en tire la **liste exacte des
   dates** (`AAAA-MM-JJ`, jours civils du fuseau du service, `Africa/Porto-Novo`, UTC+1 sans heure d'été) :
   - `dates` : liste explicite (prestation ponctuelle ou passages libres) ;
   - `weekly` : jours de semaine (`weekdays`), toutes les `everyWeeks` semaines (1 par défaut ; 2 = une
     semaine sur deux, semaines du lundi au dimanche comptées depuis celle de `startDate`), entre
     `startDate` et `endDate` incluses ;
   - `monthly` : chaque mois de la période, soit des jours du mois (`monthDays`, un jour absent du mois
     devient son dernier jour, sans doublon), soit des jours de semaine à des rangs (`weekdays` +
     `weeksOfMonth`, 1 à 4 ou `last`). Une seule des deux formes.
   - Commun : `startTime` (`HH:mm`, heure locale), `excludedDates` (fériés, absences), `extraDates`
     (ajouts ; un jour exclu le reste même s'il est ajouté). Un champ d'un autre mode est refusé, pour
     qu'une erreur d'intégration se voie.
   - Une période donnée en mois entiers (« de janvier à décembre ») est la même règle : le front envoie
     les dates de début et de fin. Pas de second format.
2. **Bornes** : période de 36 mois au plus (`CLEANING_SCHEDULE_MAX_MONTHS`, la valeur de l'ancienne
   récurrence, retenue le 2026-11-11), au plus 400 passages (`CLEANING_SCHEDULE_MAX_VISITS`), au
   moins un passage, premier passage au-delà du délai minimum des réglages (48 h). Avertissements rendus
   avec les dates : jour ramené à la fin du mois, jour exclu (prévu ou non), jour ajouté déjà prévu.
3. **Prix exact** : nombre de passages = nombre de dates. Devis : total = prix d'un passage × nombre de
   dates, acompte sur ce total ; la mission reprend ce nombre (`plannedInterventions`), donc le prix d'un
   passage du suivi des impayés (total / passages prévus) est exact lui aussi.
4. **Circuit** : le plan est fixé sur la demande (dates gardées), repris au devis — la supervision peut
   l'ajuster après la visite comme les mesures (ADR-037) ; sans plan envoyé, celui de la demande est
   recontrôlé (un premier passage devenu trop proche est refusé : il faut envoyer un plan ajusté) — puis
   copié dans la mission à l'acceptation. Avec un plan, le créneau proposé au devis est le premier passage
   (avec la durée du devis) ; les créneaux envoyés sont ignorés. La supervision planifie ensuite chaque
   passage avec ses agents, comme aujourd'hui ; sans date indiquée, c'est la prochaine date du plan encore
   sans passage, à l'heure du plan. Les passages ne sont **pas** créés d'avance à l'acceptation : un
   passage porte toujours ses agents, et 150 passages sans agents fausseraient l'état de la mission
   (« planifiée ») et l'agenda.
5. **Routes** (manifeste, OpenAPI avec exemples, zod, tests de contrat) :
   - `POST /api/v1/cleaning/schedules/preview` (public, limité comme la simulation) : le corps est le plan ;
     réponse `{ dates, count, firstDate, lastDate, warnings }` ;
   - `POST /api/v1/cleaning/simulations` : `schedule` facultatif, réponse `schedule { …dates, total,
estimate }` (prix d'un passage et fourchette × nombre de passages) ;
   - `POST /api/v1/cleaning/quote-requests` et `/quote-request-groups` : `schedule` facultatif,
     `preferredSlots` facultatifs avec un plan (premier passage, durée indicative de 2 heures) ;
   - `POST /api/v1/admin/cleaning/quote-requests/{id}/quote` et `…/quote-request-groups/{id}/quotes` :
     `schedule` facultatif (ajustement), `proposedSlots` facultatifs avec un plan ;
   - `POST /api/v1/admin/cleaning/missions/{id}/interventions` : `scheduledStart` facultatif ;
   - lecture : `schedule` et `scheduledDates` sur la demande, le devis et la mission.
6. **Compatibilité** :
   - lecture : `recurrence` reste dans toutes les réponses ; avec un plan, elle en est **déduite** pour
     les anciens lecteurs (null pour un seul passage ; `week` pour un plan hebdomadaire, `month` sinon ;
     durée = mois commencés entre le premier et le dernier passage). Billing (durée du contrat d'entreprise)
     et la règle des impayés d'un particulier en récurrent (`recurrence` non nulle) fonctionnent donc sans
     changement ; un particulier avec plusieurs passages libres est traité en récurrent ;
   - entrée : `recurrence` est **dépréciée** (proto `deprecated`, OpenAPI `deprecated`) mais acceptée un
     temps, jamais avec `schedule`. Elle est traduite en plan quand c'est exact — un passage par semaine
     (le jour de semaine du premier créneau) ou par mois (son jour du mois), depuis le premier créneau,
     pendant la durée — sinon gardée telle quelle avec l'ancien calcul approximatif ;
   - données : migration `0015_intervention_schedules` (colonnes `schedule` JSONB et `scheduled_dates`
     sur `quote_requests`, `quotes`, `missions`). Conversion quand elle est exacte : devis et missions
     ponctuels dont le jour est connu sans ambiguïté (un seul créneau) deviennent un plan d'une date. Les
     récurrences existantes ne sont pas converties (jours de semaine inconnus, nombre de passages figé dans
     un prix accepté) : elles restent lisibles, en lecture seule ; les demandes non plus (leur plan
     remplacerait les créneaux que la supervision propose au devis).
7. **Événement** : `cleaning.booking.confirmed` gagne `schedulePeriod { firstDate, lastDate }`
   (facultatif, absent sans plan), pour qu'un lecteur n'ait plus à déduire la période de `durationMonths`.
8. **Planification en lot** (décision du 2026-11-11) :
   `POST /api/v1/admin/cleaning/missions/{id}/interventions/batch` (supervision, `Idempotency-Key`
   obligatoire). Un passage par date restante du plan (sans passage actif ou fait, encore à venir), mêmes
   agents (et/ou équipe), même heure (`startTime`, celle du plan par défaut), même durée. Dates : `dates`
   (sous-ensemble des dates restantes) ou `until` (toutes jusqu'à cette date incluse) ; ni l'un ni
   l'autre : toutes. Plafond par appel `CLEANING_SCHEDULE_MAX_BATCH` (400).
   - Contrôles d'un passage seul, date par date, dans une transaction, agents verrouillés ; un passage
     d'une mission du même groupe n'est pas un conflit, et les passages du lot ne se chevauchent pas
     entre eux.
   - **Tout ou rien** par défaut : `CLEANING_TEAM_UNAVAILABLE` (409) avec `details.conflicts` (date et
     agents de chaque date en conflit), rien n'est écrit. `skipConflicts: true` : les autres dates sont
     planifiées, les dates sautées rendues dans `skipped`.
   - Idempotence par (mission, clé), table `intervention_batches` (migration 0016) écrite dans la
     transaction : un second envoi rend le premier résultat.
   - **Un seul événement** `cleaning.interventions.batch_scheduled` (nombre, premier et dernier passage,
     agents, dates sautées) au lieu d'un `cleaning.mission.scheduled` par passage : notification envoie un
     message récapitulatif au client et à chaque agent (abonnement déclaré dans `EVENT_CONSUMERS`).

## Conséquences

- Le front affiche le calendrier exact avant l'envoi (aperçu), et la simulation donne le montant sur le
  vrai nombre de passages.
- Une demande du 10/11/2026 au 11/11/2027, lundi, mercredi et samedi, compte exactement 157 passages
  (contre 156 approchés avant).
- L'annulation de la suite d'un contrat (travail séparé) dispose des dates restantes : `scheduledDates`
  de la mission moins les jours déjà couverts par un passage (`unscheduledDates`).
- Billing peut, sans urgence, lire `schedulePeriod` plutôt que `recurrence.durationMonths` pour borner
  les mois facturés (à faire par l'équipe billing ; rien ne casse en attendant).
- Le fuseau de la conversion SQL (migration 0015) est fixé à `Africa/Porto-Novo` (celui du Bénin), même
  si `CLEANING_TIME_ZONE` est réglé autrement (accepté le 2026-11-11) : un autre fuseau réglé plus tard
  ne recalcule pas les plans déjà convertis.
- Décisions du 2026-11-11 : 36 mois gardés ; créneau souhaité indicatif de 2 heures gardé ; plusieurs
  dates libres d'un particulier = contrat récurrent (suivi des impayés).
