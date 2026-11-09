import { certificateContent } from './certificate';
import { decideSend, DEFAULT_CODE_POLICY, normalizeCode } from './code-policy';
import { canCancel, canRequestSignature, formatDocumentNumber } from './document';
import { addDays, formatAmount, formatCalendarDate, formatDateTime, formatPercent } from './format';
import { maskPhone, parseEmail, parsePhone } from './phone';
import { cleanIp, cleanUserAgent, effectiveStatus, type SignatureRequestRecord } from './signature';
import { canProduce, findTemplate, templateCatalog } from './templates/catalog';

const issuer = { name: 'Groupe KSP', address: 'Cotonou, Bénin', legalDetails: '' };
const context = {
  number: 'MAN-2026-000001',
  issuedAt: new Date('2026-11-09T10:00:00Z'),
  timeZone: 'Africa/Porto-Novo',
  issuer,
};

describe('mise en forme', () => {
  it('montants en FCFA entiers, sans division, pourcentages et dates en français', () => {
    expect(formatAmount(3500)).toBe('3 500 FCFA');
    expect(formatAmount(150000)).toBe('150 000 FCFA');
    expect(formatAmount(999)).toBe('999 FCFA');
    expect(formatPercent(12.5)).toBe('12,5 %');
    expect(formatCalendarDate('2026-12-05')).toBe('5 décembre 2026');
    expect(formatDateTime(new Date('2026-11-09T22:30:05Z'), 'Africa/Porto-Novo')).toBe(
      '09/11/2026 à 23:30:05',
    );
    expect(addDays(new Date('2026-11-09T10:00:00Z'), 8).toISOString()).toBe('2026-11-17T10:00:00.000Z');
  });

  it('numéro lisible, téléphone masqué, adresses', () => {
    expect(formatDocumentNumber('PAC', 2026, 42)).toBe('PAC-2026-000042');
    expect(parsePhone('+229 01 97 00 00 45')).toBe('+2290197000045');
    expect(parsePhone('0197000045')).toBeNull();
    expect(maskPhone('+2290197000045')).toBe('+229********45');
    expect(parseEmail(' Awa@Exemple.BJ ')).toBe('awa@exemple.bj');
    expect(parseEmail('awa@')).toBeNull();
  });
});

describe('modèles', () => {
  it('catalogue : quatre modèles en version 1, dernière version par défaut', () => {
    expect(templateCatalog().map((t) => `${t.code}@${t.version}`)).toEqual([
      'recovery_mandate@1',
      'recovery_formal_notice@1',
      'recovery_settlement_agreement@1',
      'generic@1',
    ]);
    expect(findTemplate('recovery_mandate', 0)?.info.version).toBe(1);
    expect(findTemplate('recovery_mandate', 2)).toBeNull();
    expect(findTemplate('inconnu', 0)).toBeNull();
    const mandate = findTemplate('recovery_mandate', 1)!.info;
    expect(canProduce(mandate, 'recovery')).toBe(true);
    expect(canProduce(mandate, 'cleaning')).toBe(false);
    expect(canProduce(findTemplate('generic', 1)!.info, 'cleaning')).toBe(true);
  });

  it('mandat : variables typées, champ inconnu refusé, pourcentage à une décimale', () => {
    const entry = findTemplate('recovery_mandate', 1)!;
    const valid = {
      caseReference: 'REC-2026-0042',
      creditor: { name: 'Awa Dossou', kind: 'individual', address: 'Cotonou' },
      debtor: { name: 'Koffi Mensah' },
      claim: { principal: 150000, cause: 'Prêt non remboursé', dueDate: '2026-06-30', evidenceCount: 2 },
      fees: { successFeePercent: 10, fixedFee: 5000 },
      durationMonths: 6,
    };
    const prepared = entry.prepare(valid);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.document.place).toBe('Cotonou');
    const text = JSON.stringify(prepared.document.build(context));
    expect(text).toContain('150 000 FCFA');
    expect(text).toContain('10 %');
    expect(text).toContain('30 juin 2026');
    expect(text).toContain('5 000 FCFA');

    const invalid = entry.prepare({
      ...valid,
      claim: { ...valid.claim, principal: 1500.5 },
      fees: { successFeePercent: 12.55 },
      intrus: true,
    });
    expect(invalid).toEqual({
      ok: false,
      fields: expect.arrayContaining(['claim.principal', 'fees.successFeePercent', '(racine)']) as unknown,
    });
  });

  it('protocole : somme des échéances égale au total, dates croissantes', () => {
    const entry = findTemplate('recovery_settlement_agreement', 1)!;
    const base = {
      caseReference: 'REC-1',
      creditor: { name: 'SARL Bénin Propre' },
      debtor: { name: 'Koffi Mensah' },
      claim: { cause: 'Facture impayée' },
      agreedTotal: 100000,
      installments: [
        { dueDate: '2026-12-05', amount: 60000 },
        { dueDate: '2027-01-05', amount: 40000 },
      ],
      paymentInstructions: 'Mobile Money',
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const blocks = ok.document.build({ ...context, number: 'PAC-2026-000001' });
      const table = blocks.find((block) => block.kind === 'table');
      expect(table).toMatchObject({ totalRow: ['Total', '', '100 000 FCFA'] });
    }
    expect(entry.prepare({ ...base, agreedTotal: 90000 })).toEqual({ ok: false, fields: ['installments'] });
    const unordered = entry.prepare({
      ...base,
      installments: [
        { dueDate: '2027-01-05', amount: 60000 },
        { dueDate: '2026-12-05', amount: 40000 },
      ],
    });
    expect(unordered).toEqual({ ok: false, fields: ['installments.1.dueDate'] });
  });

  it('mise en demeure : date limite calculée à l’heure du Bénin, jamais signée', () => {
    const entry = findTemplate('recovery_formal_notice', 1)!;
    expect(entry.info.signature).toBe('none');
    const prepared = entry.prepare({
      caseReference: 'REC-1',
      creditor: { name: 'SARL Bénin Propre' },
      debtor: { name: 'Koffi Mensah', address: 'Akpakpa' },
      claim: { principal: 150000, cause: 'Facture impayée', additionalCharges: 10000 },
      paymentDeadlineDays: 8,
      paymentInstructions: 'Mobile Money',
      contactPhoneE164: '+2290190000000',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const text = JSON.stringify(prepared.document.build(context));
    expect(text).toContain('160 000 FCFA');
    expect(text).toContain('17 novembre 2026');
  });

  it('textes refusés : caractère de contrôle, plusieurs lignes dans un nom', () => {
    const entry = findTemplate('generic', 1)!;
    expect(entry.prepare({ title: 'Essai', paragraphs: ['Ligne 1\nLigne 2'] }).ok).toBe(true);
    expect(entry.prepare({ title: 'Essai\u0007', paragraphs: ['x'] }).ok).toBe(false);
    expect(entry.prepare({ title: 'Deux\nlignes', paragraphs: ['x'] }).ok).toBe(false);
  });
});

describe('signature', () => {
  const now = new Date('2026-11-09T10:00:00Z');
  const sent = (...secondsAgo: number[]) => secondsAgo.map((s) => new Date(now.getTime() - s * 1000));

  it('codes : 60 secondes entre deux envois, 5 par heure', () => {
    expect(decideSend([], now, DEFAULT_CODE_POLICY)).toEqual({ allowed: true });
    expect(decideSend(sent(20), now, DEFAULT_CODE_POLICY)).toEqual({
      allowed: false,
      reason: 'too_soon',
      retryAfterSeconds: 40,
    });
    expect(decideSend(sent(60), now, DEFAULT_CODE_POLICY)).toEqual({ allowed: true });
    expect(decideSend(sent(100, 200, 300, 400, 3000), now, DEFAULT_CODE_POLICY)).toEqual({
      allowed: false,
      reason: 'limit_reached',
      retryAfterSeconds: 600,
    });
    expect(normalizeCode(' 482 913 ', 6)).toBe('482913');
    expect(normalizeCode('48291', 6)).toBeNull();
    expect(normalizeCode('48291a', 6)).toBeNull();
  });

  it('statut réel, états du document, preuve nettoyée', () => {
    const request = { status: 'pending', expiresAt: now } as SignatureRequestRecord;
    expect(effectiveStatus(request, new Date(now.getTime() - 1))).toBe('pending');
    expect(effectiveStatus(request, now)).toBe('expired');
    expect(canRequestSignature('draft')).toBe(true);
    expect(canRequestSignature('expired')).toBe(true);
    expect(canRequestSignature('pending_signature')).toBe(false);
    expect(canCancel('signed')).toBe(false);
    expect(cleanIp('2001:db8::1')).toBe('2001:db8::1');
    expect(cleanIp('<script>')).toBeNull();
    expect(cleanUserAgent('Mozilla\u0000/5.0\n')).toBe('Mozilla /5.0');
    expect(cleanUserAgent('x'.repeat(400))).toHaveLength(300);
  });

  it('certificat : empreinte, signataire masqué, moyen, horodatage, pages signées', () => {
    const content = certificateContent({
      documentTitle: 'Protocole d’accord',
      documentNumber: 'PAC-2026-000001',
      pageCount: 2,
      documentSha256: 'a'.repeat(64),
      signerName: 'Koffi Mensah',
      signerHasAccount: false,
      signerPhoneMasked: '+229********45',
      channel: 'whatsapp',
      signedAt: new Date('2026-11-09T10:00:30Z'),
      ip: '197.234.10.21',
      userAgent: null,
      signatureRequestId: 'req-1',
      issuerName: 'Groupe KSP',
      timeZone: 'Africa/Porto-Novo',
    });
    const text = JSON.stringify(content);
    expect(content.title).toBe('Certificat de signature électronique');
    expect(text).toContain('les pages 1 à 2');
    expect(text).toContain('a'.repeat(64));
    expect(text).toContain('reçu par WhatsApp');
    expect(text).toContain('09/11/2026 à 11:00:30');
    expect(text).toContain('2026-11-09T10:00:30.000Z');
    expect(text).toContain('non transmis');
    expect(text).toContain('Sans compte KSP');
  });
});
