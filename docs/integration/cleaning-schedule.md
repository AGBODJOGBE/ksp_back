# Nettoyage — intégrer le plan de passages (ADR-052)

Guide court pour le front client et le back-office. Contrat complet : `contracts/openapi/ksp-api.v1.yaml`
(schémas `CleaningScheduleInput`, `CleaningSchedule`, `CleaningSchedulePreview`).

## 1. Le plan (`schedule`)

Un seul objet, envoyé tel quel dans l'aperçu, la simulation, la demande de devis et le devis.

| Champ           | Mode                         | Règle                                                           |
| --------------- | ---------------------------- | --------------------------------------------------------------- |
| `mode`          | tous                         | `dates`, `weekly` ou `monthly` (obligatoire)                    |
| `startTime`     | tous                         | `HH:mm`, heure du Bénin (obligatoire)                           |
| `dates`         | `dates`                      | 1 à N jours `AAAA-MM-JJ`                                        |
| `startDate`     | `weekly`, `monthly`          | début de la période, inclus (obligatoire)                       |
| `endDate`       | `weekly`, `monthly`          | fin de la période, incluse (obligatoire) ; 36 mois au plus      |
| `weekdays`      | `weekly` ; `monthly` (rangs) | `mon` `tue` `wed` `thu` `fri` `sat` `sun`                       |
| `everyWeeks`    | `weekly`                     | 1 chaque semaine (défaut), 2 une semaine sur deux… (12 au plus) |
| `monthDays`     | `monthly`                    | jours 1 à 31 ; un jour absent du mois → dernier jour du mois    |
| `weeksOfMonth`  | `monthly` (avec `weekdays`)  | `1` à `4` ou `"last"` — ne pas mêler avec `monthDays`           |
| `excludedDates` | tous                         | jours retirés (fériés, congés)                                  |
| `extraDates`    | tous                         | jours ajoutés ; un jour exclu le reste                          |

Un champ d'un autre mode est refusé (`CLEANING_VALIDATION_FAILED`, `details.field: "schedule.<champ>"`).
« De janvier à décembre » s'envoie comme `startDate: "2027-01-01"`, `endDate: "2027-12-31"`.

Contrôles : au moins un passage, au plus 400, premier passage au moins 48 h après maintenant
(`CLEANING_LEAD_TIME_TOO_SHORT`, 422).

## 2. Afficher le calendrier : `POST /api/v1/cleaning/schedules/preview`

Public, sans compte. Le corps est le plan.

```http
POST /api/v1/cleaning/schedules/preview
Content-Type: application/json

{ "mode": "weekly", "startDate": "2026-11-10", "endDate": "2027-11-11",
  "weekdays": ["mon", "wed", "sat"], "startTime": "08:00" }
```

```json
{
  "dates": ["2026-11-11", "2026-11-14", "2026-11-16", "…", "2027-11-10"],
  "count": 157,
  "firstDate": "2026-11-11",
  "lastDate": "2027-11-10",
  "warnings": []
}
```

Autres plans :

```json
{
  "mode": "monthly",
  "startDate": "2026-12-01",
  "endDate": "2027-05-31",
  "weekdays": ["mon"],
  "weeksOfMonth": [1],
  "startTime": "09:30",
  "excludedDates": ["2027-04-05"]
}
```

→ 5 dates (1er lundi de chaque mois sauf le lundi de Pâques), avertissement
`{ "code": "excluded", "date": "2027-04-05", "message": "…" }`.

```json
{
  "mode": "monthly",
  "startDate": "2027-01-01",
  "endDate": "2027-12-31",
  "monthDays": [5, 31],
  "startTime": "08:00"
}
```

→ le 5 et le dernier jour de chaque mois (avertissement `moved_to_month_end` pour les mois sans 31).

```json
{ "mode": "dates", "dates": ["2026-11-20", "2026-12-24", "2027-01-15"], "startTime": "14:00" }
```

Codes d'avertissement : `moved_to_month_end`, `excluded`, `excluded_not_planned`, `extra_already_planned`.

## 3. Prix estimé : `POST /api/v1/cleaning/simulations`

Ajouter `schedule` au corps habituel. La réponse garde le prix d'un passage (`computedPrice`,
`estimate`) et ajoute :

```json
"schedule": {
  "dates": ["…"], "count": 157, "firstDate": "2026-11-11", "lastDate": "2027-11-10", "warnings": [],
  "total": { "amount": 5604900, "currency": "XOF" },
  "estimate": { "low": { "amount": 5024000, "currency": "XOF" }, "high": { "amount": 6437000, "currency": "XOF" } }
}
```

`total` = prix d'un passage × nombre de passages (null si la prestation n'a pas de prix) ; `schedule`
vaut null sans plan.

## 4. Demande de devis

`POST /api/v1/cleaning/quote-requests` (ou `/quote-request-groups`, plan commun aux prestations) :
ajouter `schedule`. `preferredSlots` devient facultatif : sans lui, le créneau souhaité est le premier
passage. Ne plus envoyer `recurrence` (dépréciée ; refusée avec `schedule`).

La demande renvoyée porte `schedule` (le plan) et `scheduledDates` (les dates exactes) ; `recurrence`
reste présente, déduite du plan, pour les anciens écrans.

## 5. Back-office

- **Devis** `POST /api/v1/admin/cleaning/quote-requests/{id}/quote` : sans `schedule`, le plan de la
  demande est repris ; envoyer `schedule` pour l'ajuster après la visite. `proposedSlots` devient
  facultatif : avec un plan, le créneau proposé est le premier passage (avec `durationMinutes`).
  Total = prix d'un passage × `scheduledDates.length` (`interventionCount`). Si le premier passage de la
  demande est devenu trop proche : 422 `CLEANING_LEAD_TIME_TOO_SHORT`, envoyer un plan ajusté.
- **Acceptation** (client) : `slotStart` = `quote.proposedSlots[0].start` (le premier passage).
- **Mission** : `schedule`, `scheduledDates`, `plannedInterventions` (= nombre de dates).
- **Planifier un passage** `POST /api/v1/admin/cleaning/missions/{id}/interventions` : `scheduledStart`
  facultatif ; absent, la prochaine date du plan encore sans passage, à l'heure du plan. Les agents se
  choisissent comme avant.

## 6. Planifier toutes les dates restantes d'un coup

`POST /api/v1/admin/cleaning/missions/{id}/interventions/batch`, en-tête `Idempotency-Key` obligatoire
(un second envoi avec la même clé rend le même résultat).

```http
POST /api/v1/admin/cleaning/missions/0192f1c4-…/interventions/batch
Idempotency-Key: lot-2026-11-11-0001
Content-Type: application/json

{ "until": "2026-12-31", "startTime": "14:00", "durationMinutes": 120,
  "agentIds": ["0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002"], "skipConflicts": true }
```

- Dates : `dates` (sous-ensemble des dates restantes), ou `until` (jusqu'à cette date incluse), ou rien
  (toutes). `startTime` absent : heure du plan. 400 passages au plus par appel.
- Agents : `agentIds` et/ou `teamId`, comme pour un passage seul.
- Tout ou rien par défaut : un conflit répond 409 `CLEANING_TEAM_UNAVAILABLE` avec
  `details.conflicts: [{ "date": "2026-11-16", "agentIds": ["…"] }]` et rien n'est planifié ; avec
  `skipConflicts: true`, les autres dates sont planifiées.

```json
{
  "mission": { "id": "…", "status": "scheduled", "interventions": ["…"], "scheduledDates": ["…"] },
  "interventionIds": ["…", "…"],
  "scheduledDates": ["2026-11-11", "2026-11-14", "…"],
  "skipped": [{ "date": "2026-11-16", "agentIds": ["0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002"] }]
}
```

Le client et les agents reçoivent un seul message qui résume (nombre de passages, premier et dernier).
