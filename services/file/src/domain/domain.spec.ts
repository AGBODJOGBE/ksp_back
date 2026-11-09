import { detectContentType } from './file-signature';
import { ERASED_WITH_ACCOUNT, isPurpose, PURPOSES, purposesOfService } from './purposes';
import {
  contentProblem,
  declarationProblem,
  neutralFileName,
  sanitizeFileName,
  type StoredFile,
  SUBJECT_TYPE,
} from './stored-file';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('signature binaire', () => {
  it.each([
    ['PDF', text('%PDF-1.4\n'), 'application/pdf'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe1), 'image/jpeg'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['WebP', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'image/webp'],
  ])('%s reconnu', (_label, head, type) => {
    expect(detectContentType(head)).toBe(type);
  });

  it.each([
    ['HTML', text('<html><script>')],
    ['SVG', text('<svg xmlns=')],
    ['exécutable', bytes(0x4d, 0x5a, 0x90, 0x00)],
    ['RIFF non WebP (WAV)', text('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')],
    ['PNG tronqué', bytes(0x89, 0x50, 0x4e)],
    ['vide', bytes()],
  ])('%s refusé', (_label, head) => {
    expect(detectContentType(head)).toBeNull();
  });
});

describe('finalités', () => {
  it('liste fermée, chaque finalité a au moins un service responsable', () => {
    expect(Object.keys(PURPOSES).sort()).toEqual([
      'avatar',
      'cleaning_intervention_photo',
      'generated_document',
      'recovery_evidence',
    ]);
    for (const policy of Object.values(PURPOSES)) expect(policy.services.length).toBeGreaterThan(0);
    expect(isPurpose('avatar')).toBe(true);
    expect(isPurpose('toString')).toBe(false);
  });

  it('un service ne répond que de ses finalités', () => {
    expect(purposesOfService('cleaning')).toEqual(['cleaning_intervention_photo']);
    expect(purposesOfService('document')).toEqual(['generated_document']);
    expect(purposesOfService('gateway')).toEqual([]);
  });

  it('seule la photo de profil est effacée avec le compte : le reste est une pièce à conserver', () => {
    expect(ERASED_WITH_ACCOUNT).toEqual(['avatar']);
  });
});

describe('déclaration', () => {
  it('type et taille contrôlés par la finalité', () => {
    expect(declarationProblem('avatar', 'image/png', 1024)).toBeNull();
    expect(declarationProblem('avatar', 'application/pdf', 1024)).toEqual({
      problem: 'type_not_allowed',
      allowed: ['image/jpeg', 'image/png', 'image/webp'],
    });
    expect(declarationProblem('avatar', 'image/png', 2 * 1024 * 1024 + 1)).toEqual({
      problem: 'too_large',
      maxBytes: 2 * 1024 * 1024,
    });
    expect(declarationProblem('generated_document', 'application/pdf', 0)).toEqual({ problem: 'empty' });
    expect(declarationProblem('recovery_evidence', 'application/pdf', 10 * 1024 * 1024)).toBeNull();
  });

  it('nom nettoyé : sans chemin, sans caractère de contrôle, 200 caractères au plus', () => {
    expect(sanitizeFileName('C:\\Users\\koffi\\Reçu  mai.pdf')).toBe('Reçu mai.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\u0000b"c\nd.png')).toBe('abcd.png');
    expect(sanitizeFileName('   ')).toBeNull();
    expect(sanitizeFileName('dossier/..')).toBeNull();
    const long = sanitizeFileName(`${'x'.repeat(300)}.jpeg`)!;
    expect(long).toHaveLength(200);
    expect(long.endsWith('.jpeg')).toBe(true);
  });

  it('nom neutre d’un fichier détaché : identifiant et extension seulement', () => {
    expect(neutralFileName({ id: 'abc', contentType: 'image/jpeg' })).toBe('abc.jpg');
    expect(neutralFileName({ id: 'abc', contentType: 'application/pdf' })).toBe('abc.pdf');
  });

  it('type d’objet métier en snake_case, préfixé par son domaine', () => {
    expect(SUBJECT_TYPE.test('cleaning_intervention')).toBe(true);
    expect(SUBJECT_TYPE.test('recovery_case')).toBe(true);
    expect(SUBJECT_TYPE.test('mission')).toBe(false);
    expect(SUBJECT_TYPE.test('Cleaning_Mission')).toBe(false);
  });
});

describe('vérification du contenu reçu', () => {
  const file = { sizeBytes: 12, contentType: 'image/png' } as StoredFile;
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);

  it('conforme : taille, type enregistré et signature', () => {
    expect(contentProblem(file, { sizeBytes: 12, contentType: 'image/png', head: png })).toBeNull();
    expect(contentProblem(file, { sizeBytes: 12, contentType: null, head: png })).toBeNull();
  });

  it('taille réelle différente de la taille annoncée', () => {
    expect(contentProblem(file, { sizeBytes: 13, contentType: 'image/png', head: png })).toBe(
      'size_mismatch',
    );
  });

  it('type enregistré différent, ou signature d’un autre type (HTML déguisé en image)', () => {
    expect(contentProblem(file, { sizeBytes: 12, contentType: 'text/html', head: png })).toBe(
      'type_mismatch',
    );
    expect(
      contentProblem(file, { sizeBytes: 12, contentType: 'image/png', head: text('<html><body>') }),
    ).toBe('type_mismatch');
    expect(
      contentProblem(file, { sizeBytes: 12, contentType: 'image/png', head: bytes(0xff, 0xd8, 0xff, 0xe0) }),
    ).toBe('type_mismatch');
  });
});
