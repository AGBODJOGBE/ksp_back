# ADR-021 — WhatsApp par l'API officielle de Meta (WhatsApp Cloud API)

**Statut** : Accepté (décision du porteur du projet, 2026-10-19)

## Contexte

`notification` envoie les codes de connexion (ADR-014), puis les notifications métier. Un prestataire passant par un téléphone Android et par un compte WhatsApp relié par QR code (WaChap) a été envisagé puis écarté : point de panne unique, et risque de bannissement hors API officielle.

## Décision

**WhatsApp Cloud API de Meta**, appelée directement par `notification`, derrière un port « fournisseur de canal » : l'adaptateur WhatsApp est remplaçable sans toucher au reste du service.

| Sujet              | Fonctionnement (documentation Meta, 2026-10-19)                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envoi              | `POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages`, jeton `Authorization: Bearer` d'un utilisateur système du compte Meta                                                  |
| Codes de connexion | Modèle de catégorie **authentication** avec bouton « Copier le code » ; le code (15 caractères au plus) est transmis dans le corps et dans le bouton ; durée de vie `message_send_ttl_seconds` |
| Modèles            | Créés par `POST /<WABA_ID>/message_templates` puis **approuvés par Meta** avant tout envoi ; pas d'URL, de média ni d'emoji dans un modèle d'authentification                                  |
| Remise             | Le message d'authentification n'arrive que sur le téléphone principal de l'utilisateur ; statuts (envoyé, remis, lu, échoué) reçus par webhook                                                 |
| Webhooks           | Reçus par la gateway sur `/webhooks/whatsapp` et transmis bruts à `notification`, qui vérifie la signature (UC-GW-11)                                                                          |

## Préalables (à lancer tôt, ils prennent du temps)

1. Portefeuille d'entreprise Meta (Business Manager) au nom de KSP, **vérification de l'entreprise**.
2. Compte WhatsApp Business et **numéro dédié à KSP**, non utilisé dans l'application WhatsApp ; nom affiché approuvé.
3. Utilisateur système et jeton permanent ; moyen de paiement (les messages d'authentification sont facturés par message, selon le pays).
4. **Modèle `ksp_otp`** (catégorie authentication, français, expiration 5 minutes) soumis à l'approbation.

## À valider

- **Canal SMS** : sans prestataire SMS, un utilisateur sans WhatsApp ne peut pas recevoir de code. Choisir un agrégateur SMS (avec nom d'expéditeur « KSP ») ou faire de WhatsApp le seul canal au lancement.
- Vérifier lors de l'intégration si la « poignée de main » décrite par Meta concerne aussi le bouton « Copier le code » ou seulement le remplissage automatique sur Android.

## Alternatives écartées

- **WaChap** : SMS envoyés depuis un téléphone Android (point de panne unique, numéro ordinaire), WhatsApp par appareil lié hors API officielle (risque de bannissement).
- **Fournisseurs intermédiaires de l'API WhatsApp (BSP)** : utiles pour l'accompagnement, mais un coût de plus pour la même API.

## Conséquences

- Secrets dans le coffre (secret k3s, ADR-018) : jeton de l'utilisateur système, `PHONE_NUMBER_ID`, identifiant du compte WhatsApp Business, secret de l'application pour vérifier les webhooks.
- `notification` gère les statuts de remise reçus par webhook ; `SendNotification` répond `ACCEPTED` à l'envoi, jamais `SENT` sans accusé.
- En développement, aucun appel à Meta : le code est écrit dans le terminal (garde-fou en production).
