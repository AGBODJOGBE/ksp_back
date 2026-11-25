import { matchesSignature } from './file-signature';
import { type ContentType, ERASED_WITH_ACCOUNT, isPurpose, PURPOSES, purposesOfService } from './purposes';
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
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_HEAD = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00);

describe('signature binaire', () => {
  it.each<[string, Uint8Array, ContentType]>([
    ['PDF', text('%PDF-1.4\n'), 'application/pdf'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe1), 'image/jpeg'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['WebP', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'image/webp'],
    ['ZIP', ZIP_HEAD, 'application/zip'],
    ['XLSX (archive ZIP)', ZIP_HEAD, XLSX],
    ['CSV', text('reference;debiteur;montant\r\nA-1;Koffi;15000\n'), 'text/csv'],
    ['CSV avec tabulations et marque UTF-8', text('\uFEFFréférence\tmontant\n'), 'text/csv'],
    [
      'CSV en Windows-1252',
      bytes(0x72, 0xe9, 0x66, 0x3b, 0x6d, 0x6f, 0x6e, 0x74, 0x61, 0x6e, 0x74),
      'text/csv',
    ],
  ])('%s reconnu', (_label, head, type) => {
    expect(matchesSignature(type, head)).toBe(true);
  });

  it.each<[string, Uint8Array, ContentType]>([
    ['HTML', text('<html><script>'), 'image/png'],
    ['SVG', text('<svg xmlns='), 'image/png'],
    ['exécutable', bytes(0x4d, 0x5a, 0x90, 0x00), 'application/pdf'],
    ['RIFF non WebP (WAV)', text('RIFF\u0000\u0000\u0000\u0000WAVEfmt '), 'image/webp'],
    ['PNG tronqué', bytes(0x89, 0x50, 0x4e), 'image/png'],
    ['JPEG annoncé PNG', bytes(0xff, 0xd8, 0xff, 0xe1), 'image/png'],
    ['vide', bytes(), 'application/pdf'],
    ['PDF annoncé ZIP', text('%PDF-1.4\n'), 'application/zip'],
    ['ZIP vide (fin d’archive seule)', bytes(0x50, 0x4b, 0x05, 0x06), 'application/zip'],
    ['ancien classeur Excel (OLE)', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), XLSX],
    ['exécutable annoncé CSV', bytes(0x4d, 0x5a, 0x90, 0x00), 'text/csv'],
    ['classeur XLSX annoncé CSV', ZIP_HEAD, 'text/csv'],
    ['CSV en UTF-16', bytes(0xff, 0xfe, 0x61, 0x00, 0x3b, 0x00), 'text/csv'],
    ['caractère de contrôle dans un CSV', text('a;b\u001bc\n'), 'text/csv'],
    ['CSV vide', bytes(), 'text/csv'],
  ])('%s refusé', (_label, head, type) => {
    expect(matchesSignature(type, head)).toBe(false);
  });
});

describe('finalités', () => {
  it('liste fermée, chaque finalité a au moins un service responsable', () => {
    expect(Object.keys(PURPOSES).sort()).toEqual([
      'avatar',
      'cleaning_intervention_photo',
      'generated_document',
      'recovery_debtor_evidence',
      'recovery_evidence',
      'recovery_evidence_archive',
      'recovery_import',
    ]);
    for (const policy of Object.values(PURPOSES)) expect(policy.services.length).toBeGreaterThan(0);
    expect(isPurpose('avatar')).toBe(true);
    expect(isPurpose('toString')).toBe(false);
  });

  it('un service ne répond que de ses finalités', () => {
    expect(purposesOfService('cleaning')).toEqual(['cleaning_intervention_photo']);
    expect(purposesOfService('document')).toEqual(['generated_document']);
    expect(purposesOfService('recovery')).toEqual([
      'recovery_evidence',
      'recovery_import',
      'recovery_evidence_archive',
      'recovery_debtor_evidence',
    ]);
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

  it('pièces du Recouvrement : tableur d’import, archive des justificatifs, pièces du débiteur', () => {
    expect(declarationProblem('recovery_import', XLSX, 5 * 1024 * 1024)).toBeNull();
    expect(declarationProblem('recovery_import', 'text/csv', 1024)).toBeNull();
    expect(declarationProblem('recovery_import', 'text/csv', 5 * 1024 * 1024 + 1)).toEqual({
      problem: 'too_large',
      maxBytes: 5 * 1024 * 1024,
    });
    expect(declarationProblem('recovery_import', 'application/vnd.ms-excel', 1024)).toEqual({
      problem: 'type_not_allowed',
      allowed: [XLSX, 'text/csv'],
    });
    expect(declarationProblem('recovery_evidence_archive', 'application/zip', 50 * 1024 * 1024)).toBeNull();
    expect(declarationProblem('recovery_evidence_archive', 'application/pdf', 1024)).toMatchObject({
      problem: 'type_not_allowed',
    });
    expect(declarationProblem('recovery_debtor_evidence', 'image/webp', 10 * 1024 * 1024)).toBeNull();
    expect(declarationProblem('recovery_debtor_evidence', 'application/zip', 1024)).toMatchObject({
      problem: 'type_not_allowed',
    });
    expect(PURPOSES.recovery_debtor_evidence.uploadedBy).toBe('service');
    expect(PURPOSES.recovery_import.uploadedBy).toBe('user');
    expect(PURPOSES.recovery_evidence_archive.uploadedBy).toBe('user');
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
    expect(neutralFileName({ id: 'abc', contentType: XLSX })).toBe('abc.xlsx');
    expect(neutralFileName({ id: 'abc', contentType: 'text/csv' })).toBe('abc.csv');
    expect(neutralFileName({ id: 'abc', contentType: 'application/zip' })).toBe('abc.zip');
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

  it('tableur et archive : signature ZIP ; CSV : du texte', () => {
    const csv = { sizeBytes: 9, contentType: 'text/csv' } as StoredFile;
    expect(
      contentProblem(csv, { sizeBytes: 9, contentType: 'text/csv', head: text('a;b\r\n1;2\n') }),
    ).toBeNull();
    expect(
      contentProblem(csv, { sizeBytes: 9, contentType: 'text/csv', head: bytes(0x4d, 0x5a, 0x90, 0x00) }),
    ).toBe('type_mismatch');
    const xlsx = { sizeBytes: 8, contentType: XLSX } as StoredFile;
    expect(contentProblem(xlsx, { sizeBytes: 8, contentType: XLSX, head: ZIP_HEAD })).toBeNull();
    expect(contentProblem(xlsx, { sizeBytes: 8, contentType: 'application/zip', head: ZIP_HEAD })).toBe(
      'type_mismatch',
    );
  });
});
