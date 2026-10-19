# ADR-021 — Prestataire SMS et WhatsApp : WaChap

**Statut** : Accepté (décision du porteur du projet, 2026-10-19)

## Contexte

`notification` envoie les codes de connexion (ADR-014) par SMS, avec bascule sur WhatsApp, puis toutes les notifications métier. Le porteur du projet retient WaChap, déjà utilisé par une autre de ses plateformes.

## Décision

**WaChap**, derrière un port « fournisseur de canal » dans `notification` : un adaptateur SMS et un adaptateur WhatsApp, remplaçables chacun sans toucher au reste du service.

Fonctionnement constaté (documentation WaChap, 2026-10-19) :

| Canal    | Fonctionnement                                                                                                 | API                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SMS      | Envoyé **depuis un téléphone Android** muni de l'application WaChap SMS, avec le numéro de sa carte SIM        | `POST https://api.wachap.com/v1/sms/send-sms` (`phone_number`, `message`)                      |
| WhatsApp | Compte WhatsApp relié à WaChap **par QR code ou code PIN** (appareil lié), et non par l'API officielle de Meta | `POST https://api.wachap.com/v1/whatsapp/messages/send` (`accountId`, `to`, `type`, `content`) |

Authentification par clé secrète (`Authorization: Bearer sk_…`). Limites du plan gratuit : 60 requêtes par minute, 1 000 messages par heure.

## Risques et parades

| Risque                                                                                                                                   | Parade                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le téléphone Android est un point de panne unique (batterie, réseau, application arrêtée)                                                | Supervision du taux d'échec et alerte (`notification.message.failed`) ; un second téléphone de secours ; bascule automatique sur WhatsApp                       |
| Une réponse HTTP 200 peut cacher un refus (`success: false`), comme constaté sur l'autre plateforme                                      | L'adaptateur considère l'envoi réussi seulement si `success` vaut `true`                                                                                        |
| Les SMS partent d'un numéro mobile ordinaire, pas d'un nom d'expéditeur « KSP » ; l'opérateur peut limiter ou bloquer un envoi en volume | Texte des codes qui nomme KSP ; volume à surveiller ; passage à un agrégateur SMS si le volume grandit (seul l'adaptateur change)                               |
| WhatsApp hors API officielle : le compte peut être restreint ou banni par WhatsApp en cas d'envoi automatisé jugé abusif                 | WhatsApp réservé au secours et aux messages attendus par l'utilisateur ; numéro dédié à KSP ; passage à l'API officielle de Meta possible sans changer le reste |
| Pas d'accusé de remise documenté                                                                                                         | Statut `ACCEPTED` côté notification (pris en charge), jamais `SENT` sans preuve                                                                                 |

## Alternatives écartées

- **API WhatsApp Business officielle de Meta** et **agrégateurs SMS avec nom d'expéditeur** : plus robustes, mais plus coûteux et plus longs à mettre en place ; restent la voie d'évolution prévue par le port.

## Conséquences

- La démarche de compte WhatsApp Business et de modèle approuvé par Meta n'est plus un préalable au lot 1.
- Préproduction : un téléphone Android dédié à KSP, avec l'application WaChap SMS, une carte SIM et un forfait SMS ; un numéro WhatsApp dédié relié à WaChap.
- Secrets : `WACHAP_API_KEY` et l'identifiant du compte WhatsApp dans le coffre (secret k3s, ADR-018).
