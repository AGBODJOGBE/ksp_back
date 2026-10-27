/** Forme volontairement simple : une partie locale, un @, un domaine avec au moins un point. */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const MAX_LENGTH = 254;

/**
 * Adresse e-mail du profil. Conservée en minuscules : deux saisies qui ne diffèrent que par la
 * casse désignent la même adresse (unicité entre comptes). La seule preuve qu'elle est juste et
 * qu'elle appartient au titulaire du compte est le code qui y est envoyé.
 */
export class EmailAddress {
  private constructor(readonly value: string) {}

  /** Renvoie null si la valeur n'est pas une adresse plausible (espaces autour retirés). */
  static parse(value: string): EmailAddress | null {
    const compact = value.trim().toLowerCase();
    return compact.length <= MAX_LENGTH && EMAIL.test(compact) ? new EmailAddress(compact) : null;
  }

  /**
   * Forme masquée, seule écrite dans les événements : première lettre de la partie locale et
   * domaine, par exemple k***@exemple.com (même forme que dans notification).
   */
  masked(): string {
    const at = this.value.lastIndexOf('@');
    return `${this.value.slice(0, 1)}***${this.value.slice(at)}`;
  }
}
