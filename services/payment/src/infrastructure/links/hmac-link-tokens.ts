import { createHash, createHmac } from 'node:crypto';
import { type LinkTokens } from '../../application/ports';

/**
 * Jetons des liens de paiement (ADR-038) : HMAC-SHA256 de l'identifiant du lien avec un secret du
 * service (PAYMENT_LINK_TOKEN_SECRET), en base64url (43 caractères, 256 bits). Imprévisible sans le
 * secret ; recalculable par payment (rejeu d'une création, adresse relue par l'émetteur) sans jamais
 * enregistrer le jeton : la base ne garde que son empreinte SHA-256, qui sert à retrouver le lien.
 * Changer le secret n'invalide pas les liens existants (l'empreinte reste en base) mais empêche de
 * recalculer leur adresse : à faire en révoquant et recréant les liens encore utiles.
 */
export class HmacLinkTokens implements LinkTokens {
  constructor(private readonly secret: string) {}

  issue(linkId: string): string {
    return createHmac('sha256', this.secret).update(`ksp-payment-link:v1:${linkId}`).digest('base64url');
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
