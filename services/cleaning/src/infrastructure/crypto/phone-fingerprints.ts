import { type BlindIndex } from '@ksp/platform';
import { type PhoneFingerprints } from '../../application/agents/agent.ports';

/**
 * Empreinte à clé du numéro invité (piste A, R-AG-02) : BlindIndex du kit (HMAC-SHA256, clé du
 * trousseau CLEANING_BLIND_INDEX_KEYS), avec une finalité propre à la colonne. Le numéro est ramené à
 * la forme commune (ADR-063) avant le calcul.
 */
export class BlindIndexPhoneFingerprints implements PhoneFingerprints {
  constructor(private readonly index: BlindIndex) {}

  invitationPhone(phone: string): string {
    return this.index.phone('agent_invitation_phone', phone);
  }
}
