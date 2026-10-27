import { EmailAddress } from './email-address';

describe('EmailAddress', () => {
  it.each(['koffi@exemple.com', 'compta.entreprise+factures@ksp.bj', 'a@b.co'])('accepte %s', (value) => {
    expect(EmailAddress.parse(value)?.value).toBe(value);
  });

  it('retire les espaces autour et met l’adresse en minuscules', () => {
    expect(EmailAddress.parse('  Koffi.Adjovi@Exemple.COM ')?.value).toBe('koffi.adjovi@exemple.com');
  });

  it.each(['', 'koffi', 'koffi@', '@exemple.com', 'koffi@exemple', 'ko ffi@exemple.com', 'a@b@c.com'])(
    'refuse %p',
    (value) => {
      expect(EmailAddress.parse(value)).toBeNull();
    },
  );

  it('refuse une adresse de plus de 254 caractères', () => {
    expect(EmailAddress.parse(`${'a'.repeat(60)}@${'b'.repeat(190)}.com`)).toBeNull();
  });

  it('masque la partie locale sauf sa première lettre', () => {
    expect(EmailAddress.parse('koffi@exemple.com')?.masked()).toBe('k***@exemple.com');
  });
});
