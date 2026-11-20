import { phoneLookupForms, tryNormalizePhone } from './phone';

describe('téléphones reçus en entrée', () => {
  it('tryNormalizePhone applique la règle de normalizePhone sans exception', () => {
    // Bénin à 8 chiffres : préfixe 01 ajouté (ADR-063).
    expect(tryNormalizePhone('+22997000101')).toBe('+2290197000101');
    expect(tryNormalizePhone('+229 97 00 01 01')).toBe('+2290197000101');
    expect(tryNormalizePhone('00229 97-00-01-01')).toBe('+2290197000101');
    // Fixe (ancien 21 30 00 00) : même préfixe 01 depuis le 30/11/2024.
    expect(tryNormalizePhone('+229 21 30 00 00')).toBe('+2290121300000');
    // Idempotente : la forme normalisée ne change plus.
    expect(tryNormalizePhone('+2290197000101')).toBe(tryNormalizePhone(tryNormalizePhone('+22997000101')));
    // Bénin à 10 chiffres : inchangé.
    expect(tryNormalizePhone('+2290197000101')).toBe('+2290197000101');
    // Autres pays : inchangés.
    expect(tryNormalizePhone('+33612345678')).toBe('+33612345678');
    expect(tryNormalizePhone('+22890000101')).toBe('+22890000101');
    // Illisible : null.
    for (const value of ['', '97000101', '+0123', '22997000101', null, undefined]) {
      expect(tryNormalizePhone(value)).toBeNull();
    }
  });

  it('phoneLookupForms ajoute l’ancienne forme d’un numéro béninois', () => {
    expect(phoneLookupForms('+2290197000101')).toEqual(['+2290197000101', '+22997000101']);
    expect(phoneLookupForms('+22997000101')).toEqual(['+2290197000101', '+22997000101']);
    // Un numéro à 10 chiffres qui ne commence pas par 01 n'a pas d'ancienne forme.
    expect(phoneLookupForms('+2290297000101')).toEqual(['+2290297000101']);
    expect(phoneLookupForms('+33612345678')).toEqual(['+33612345678']);
    expect(phoneLookupForms('illisible')).toEqual(['illisible']);
  });
});
