import { type PartnerKind } from '../../domain/partner';
import { type DecisionAnswer } from '../../domain/decision';
import { type DecisionRecord } from '../amicable/amicable.ports';
import { type RecoveryCaseRecord } from '../cases/ports';
import { type FeeQuoteRecord } from './litigation.ports';

/**
 * Décisions des étapes payantes (R-PR-04) vues par la procédure amiable (lot R4), qui les liste, les
 * fait trancher par le créancier et les fait expirer : le contentieux (lot R5) les présente avec leur
 * devis, exécute la réponse (provision débitée, étape ouverte) et l'expiration (dossier clos
 * « abandon par le créancier »).
 */

/** Partenaire nommé sur un devis : le créancier le voit avant d'accepter (R-HU-02). */
export interface PartnerRef {
  id: string;
  kind: PartnerKind;
  name: string;
  office: string | null;
}

export interface FeeQuoteView {
  quote: FeeQuoteRecord;
  partner: PartnerRef | null;
}

/** Réponse du créancier déjà contrôlée (décision en attente, dossier du créancier, clé). */
export interface EscalationAnswer {
  record: RecoveryCaseRecord;
  decision: DecisionRecord;
  answer: DecisionAnswer;
  comment: string | null;
  idempotencyKey: string;
  creditorUserId: string;
}

export interface EscalationDecisions {
  feeQuote(id: string): Promise<FeeQuoteView | null>;
  /** Exécute la réponse et enregistre la décision tranchée, dans une seule transaction. */
  answer(input: EscalationAnswer): Promise<void>;
  /** Décision échue : vrai si elle a été expirée par cet appel. */
  expire(decision: DecisionRecord): Promise<boolean>;
}
