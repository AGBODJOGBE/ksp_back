# ADR-026 — E-mail du profil vérifié par un code envoyé par e-mail

**Statut** : Accepté (lot 2, avant l'envoi des factures des entreprises par e-mail)

## Contexte

Les entreprises clientes du Nettoyage reçoivent une facture mensuelle « dans l'espace et par e-mail » (ADR-025). `notification` lit les adresses dans identity (`GetUsersByIds`, ADR-024), mais le profil n'avait pas d'e-mail. Une adresse mal saisie enverrait des factures (montants, nom de l'entreprise) à un inconnu : l'adresse doit être prouvée avant de servir.

## Décision

1. **Une adresse n'est enregistrée qu'après sa confirmation.** `ChangeEmail` envoie un code à la nouvelle adresse ; `ConfirmEmail` l'enregistre dans `users.email` (en minuscules) avec `email_verified_at`. D'ici là, l'ancienne adresse vérifiée reste celle du compte ; la nouvelle est l'« adresse en attente » du profil (`pendingEmail`).
2. **Mêmes règles que les codes par téléphone** (UC-ID-01) : code de 6 chiffres conservé en HMAC, 5 essais, limites d'envoi (60 secondes, 5 par heure, 10 par jour) appliquées **par adresse et par compte** ; validité de 15 minutes (`EMAIL_OTP_TTL_SECONDS`). Les demandes vivent dans leur propre table `email_verifications` ; seule la **dernière demande** d'un compte peut être confirmée.
3. **Envoi par appel gRPC direct** à `notification` (`SendNotification`, ADR-014), modèle secret `identity.email_verification`, e-mail seul (Brevo, ADR-024). Événements : `identity.otp.requested` (`purpose: email_verification`, ajout à l'énumération) et `identity.user.verified` (`verifiedVia: email`).
4. **Une adresse confirmée n'appartient qu'à un compte** (index unique). Anti-énumération : la demande répond de la même façon que l'adresse soit libre ou non ; le conflit (`IDENTITY_EMAIL_ALREADY_USED`) n'est signalé qu'après la saisie du bon code, qui prouve que l'adresse est à l'utilisateur.
5. **Règle d'envoi** : `GetUser` et `GetUsersByIds` rendent `email` et `email_verified` ; `notification` ne retient l'e-mail d'un destinataire que s'il est vérifié. Sinon aucun e-mail ne part (factures, devis, comptes rendus, avis d'impayés) : le message reste visible dans l'espace KSP et part par WhatsApp quand la règle du message le prévoit.
6. **Erreurs** : le code suit les erreurs des codes par téléphone (`IDENTITY_OTP_INVALID`, `_EXPIRED`, `_TOO_MANY_ATTEMPTS`, `_RATE_LIMITED`, `_SEND_FAILED`) ; l'adresse a les siennes (`IDENTITY_EMAIL_INVALID`, `IDENTITY_EMAIL_ALREADY_VERIFIED`, `IDENTITY_EMAIL_ALREADY_USED`).

## Alternatives écartées

- **Réutiliser la table `otp_challenges`** (nouvel objet et canal `email`) : la validation des codes de connexion (`VerifyOtp`) aurait pu consommer un code d'e-mail et créer un compte avec une adresse pour numéro, faute d'un contrôle de l'objet ; le compte demandeur n'y figure pas.
- **Enregistrer l'adresse tout de suite, marquée « non vérifiée »** : l'ancienne adresse vérifiée serait perdue au premier changement, et chaque lecteur devrait filtrer les adresses non vérifiées.
- **Lien de confirmation cliquable** : demande une page d'atterrissage et un jeton dans une adresse web ; le code reprend le parcours déjà connu des utilisateurs (téléphone) et fonctionne dans l'application mobile.

## Conséquences

- Les événements de facturation (`billing.invoice.*`) ne sont pas encore écoutés par `notification` : leur branchement appliquera d'office la règle du point 5.
- L'ancienne adresse n'est pas prévenue d'un changement d'e-mail (à ajouter avec les préférences de notification).
- Les lignes de `email_verifications` sont gardées comme trace (adresse, adresse IP, essais, dates) : leur durée de conservation sera fixée avec les règles de protection des données.
