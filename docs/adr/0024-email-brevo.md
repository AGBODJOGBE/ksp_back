# ADR-024 — E-mail par Brevo (API transactionnelle)

**Statut** : Accepté (décision du porteur du projet, 2026-10-23)

## Contexte

Au lot 2, `notification` prévient les clients et les agents à chaque étape du Nettoyage. Certains messages appellent l'e-mail : devis envoyé, compte rendu de fin de mission, et bientôt les factures mensuelles des entreprises (cahier des charges Nettoyage, partie 10 : facture « dans l'espace et par e-mail »). Il faut un prestataire d'envoi d'e-mails transactionnels.

## Décision

**Brevo** (anciennement Sendinblue), API transactionnelle v3, appelée directement par `notification` derrière le port « fournisseur de canal » (ADR-021) : l'adaptateur e-mail est remplaçable sans toucher au reste du service.

Raisons retenues par le porteur du projet :

- formule gratuite de **300 e-mails par jour**, suffisante pour le lancement ;
- entreprise **européenne** (données traitées dans l'Union européenne) ;
- interface d'administration **en français**.

| Sujet      | Fonctionnement                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Envoi      | `POST https://api.brevo.com/v3/smtp/email`, clé d'API dans l'en-tête `api-key` ; réponse `201` avec `messageId`                             |
| Contenu    | Objet, texte brut et version HTML produits par `notification` (modèles versionnés dans `domain/messages`), sans modèle stocké chez Brevo    |
| Expéditeur | Adresse d'un domaine KSP **vérifié chez Brevo** (enregistrements SPF et DKIM, DMARC conseillé)                                              |
| Délai      | `EMAIL_TIMEOUT_MS` (5 secondes par défaut), par `AbortSignal.timeout`                                                                       |
| Erreurs    | Panne, 429 et quota du jour épuisé (402) : prestataire indisponible ; 400 `invalid_parameter` : destinataire ; autres refus : configuration |
| Journaux   | Statut HTTP et code d'erreur Brevo seulement : ni la clé, ni l'adresse, ni le texte du message                                              |

## Développement

Prestataire `console` : l'e-mail (objet et texte) est écrit dans le terminal avec l'adresse masquée, aucun appel à Brevo. Le service refuse de démarrer avec `console` en production, et la fabrique des prestataires le vérifie une seconde fois (même garde-fou que WhatsApp).

## Préalables

1. Compte Brevo au nom de KSP.
2. Domaine d'expédition vérifié (SPF, DKIM) et adresse d'expédition, par exemple `notifications@ksp.bj`.
3. Clé d'API dans le coffre à secrets (`BREVO_API_KEY`).

## À valider

- Volume : au-delà de 300 e-mails par jour (factures mensuelles en fin de mois, par exemple), passer à une formule payante ; en attendant, un envoi refusé pour quota est traité comme une indisponibilité (bascule sur WhatsApp quand c'est possible).
- Statuts de remise (remis, rebond, plainte) par webhook Brevo : non branchés au lot 2.

## Alternatives écartées

- **SendGrid, Mailgun, Amazon SES** : sociétés américaines ; SES impose un compte AWS et une sortie du « bac à sable ».
- **Serveur SMTP maison** : délivrabilité difficile à obtenir et à surveiller.

## Conséquences

- Variables : `NOTIFICATION_EMAIL_PROVIDER` (`console` | `brevo`, `brevo` par défaut en production), `BREVO_API_KEY`, `EMAIL_SENDER_ADDRESS`, `EMAIL_SENDER_NAME`, `EMAIL_TIMEOUT_MS`.
- Les adresses e-mail des clients viennent d'identity (`GetUsersByIds`) ; tant qu'identity ne les enregistre pas (UC-ID-02), les messages partent par WhatsApp.
