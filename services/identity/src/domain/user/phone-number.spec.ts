import { PhoneNumber } from './phone-number';

describe('PhoneNumber', () => {
  it.each(['+2290197000045', '+33612345678', '+14155550123'])(
    'accepte le numéro international %s',
    (value) => {
      expect(PhoneNumber.parse(value)?.e164).toBe(value);
    },
  );

  it('tolère les espaces de saisie', () => {
    expect(PhoneNumber.parse('+229 01 97 00 00 45')?.e164).toBe('+2290197000045');
  });

  it('réécrit un numéro béninois à 8 chiffres en +229 01 suivi des 8 chiffres (ADR-063)', () => {
    expect(PhoneNumber.parse('+22997000045')?.e164).toBe('+2290197000045');
    expect(PhoneNumber.parse('+229 97 00 00 45')?.e164).toBe('+2290197000045');
    expect(PhoneNumber.parse('0022997000045')?.e164).toBe('+2290197000045');
  });

  it('garde un numéro béninois à 10 chiffres et les numéros des autres pays', () => {
    expect(PhoneNumber.parse('+2290197000045')?.e164).toBe('+2290197000045');
    expect(PhoneNumber.parse('+22890000045')?.e164).toBe('+22890000045');
    expect(PhoneNumber.parse('+33612345678')?.e164).toBe('+33612345678');
  });

  it.each(['0197000045', '+0197000045', '+229', '+229abc0000045', '', '+1234567890123456'])(
    'refuse %p',
    (value) => {
      expect(PhoneNumber.parse(value)).toBeNull();
    },
  );

  it("masque tout sauf l'indicatif et les deux derniers chiffres", () => {
    expect(PhoneNumber.parse('+2290197000045')?.masked()).toBe('+229********45');
    expect(PhoneNumber.parse('+33612345678')?.masked()).toBe('+336******78');
  });
});
