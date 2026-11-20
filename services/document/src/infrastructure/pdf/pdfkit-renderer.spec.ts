import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import PDFKitDocument from 'pdfkit';
import { certificateContent } from '../../domain/certificate';
import { type DocumentContent } from '../../domain/content';
import { findTemplate } from '../../domain/templates/catalog';
import { MAX_ENTRIES } from '../../domain/templates/recovery-evidence-log.v1';
import {
  cacheLayout,
  type EmbeddedFont,
  FEATURES,
  type LayoutRun,
  layoutStore,
  PdfKitRenderer,
} from './pdfkit-renderer';

const issuer = { name: 'Groupe KSP', address: 'Cotonou, Bénin', legalDetails: 'RCCM à compléter' };
const meta = { title: 'Protocole', createdAt: new Date('2026-11-09T10:00:00Z') };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

function agreement(installments: number): DocumentContent {
  const entry = findTemplate('recovery_settlement_agreement', 1)!;
  const prepared = entry.prepare({
    caseReference: 'REC-2026-0042',
    creditor: { name: 'SARL Bénin Propre' },
    debtor: { name: 'Koffi Mensah', phoneE164: '+2290197000045', address: 'Akpakpa, Cotonou' },
    claim: { cause: 'Facture de prestation n° 18 impayée depuis le 12 mai 2026' },
    agreedTotal: installments * 10000,
    installments: Array.from({ length: installments }, (_, index) => ({
      dueDate: `${2027 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-05`,
      amount: 10000,
    })),
    paymentInstructions: 'Mobile Money au +2290190000000, référence REC-2026-0042.',
  });
  if (!prepared.ok) throw new Error(prepared.fields.join(','));
  const number = 'PAC-2026-000001';
  return {
    title: prepared.document.title,
    number,
    dateLine: 'Fait à Cotonou, le 9 novembre 2026',
    blocks: prepared.document.build({
      number,
      issuedAt: meta.createdAt,
      timeZone: 'Africa/Porto-Novo',
      issuer,
    }),
  };
}

function evidenceLog(entries: number): DocumentContent {
  const entry = findTemplate('recovery_evidence_log', 1)!;
  const prepared = entry.prepare({
    caseReference: 'RC-000123',
    creditor: { name: 'SARL Bénin Propre' },
    debtor: { name: 'Koffi Mensah' },
    openedOn: '2026-01-02',
    currentStage: 'Huissier',
    entries: Array.from({ length: entries }, (_, index) => ({
      at: new Date(Date.UTC(2026, 0, 2, 8) + index * 3_600_000).toISOString(),
      action: index % 2 === 0 ? 'Relance par message' : 'Appel sortant',
      actor: index % 2 === 0 ? 'Système' : 'A. Hounsou, chargé de recouvrement',
      channel: index % 2 === 0 ? 'WhatsApp' : 'Appel',
      ...(index % 2 === 0 ? { delivery: 'delivered' } : { outcome: 'Pas de réponse' }),
    })),
  });
  if (!prepared.ok) throw new Error(prepared.fields.join(','));
  const number = 'JDP-2026-000001';
  return {
    title: prepared.document.title,
    number,
    dateLine: 'Fait à Cotonou, le 9 novembre 2026',
    blocks: prepared.document.build({
      number,
      issuedAt: meta.createdAt,
      timeZone: 'Africa/Porto-Novo',
      issuer,
    }),
  };
}

describe('PdfKitRenderer', () => {
  const renderer = new PdfKitRenderer(issuer);

  it('met en page un long journal de preuve sur plusieurs pages, identique d’un rendu à l’autre', async () => {
    // Moteur neuf (aucune mise en forme gardée), puis le même moteur réchauffé, puis un autre moteur
    // qui a déjà rendu autre chose : les mises en forme gardées ne changent pas un octet.
    const cold = new PdfKitRenderer(issuer);
    const first = await cold.render(evidenceLog(400), meta);
    const second = await cold.render(evidenceLog(400), meta);
    const other = new PdfKitRenderer(issuer);
    await other.render(agreement(12), meta);
    const third = await other.render(evidenceLog(400), meta);
    expect(sha(first)).toBe(sha(second));
    expect(sha(third)).toBe(sha(first));
    expect(await renderer.pageCount(first)).toBeGreaterThan(5);
  }, 60_000);

  it('rend le plus long journal permis (1 000 entrées) dans un délai raisonnable', async () => {
    const content = evidenceLog(MAX_ENTRIES);
    const start = performance.now();
    const pdf = await new PdfKitRenderer(issuer).render(content, meta);
    const elapsed = performance.now() - start;
    expect(await renderer.pageCount(pdf)).toBeGreaterThan(20);
    // Environ 1 s en local, une vingtaine de secondes sans le cache des mises en forme : seuil
    // large, pour ne pas échouer sur une machine de CI chargée, mais qui détecte la perte du cache.
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);

  it('dépend de PDFKit 0.20.2, version figée (méthodes internes `_text`, `layoutRun`)', () => {
    // Changer de version impose de revoir `cacheLayout` et `wrapLines` dans pdfkit-renderer.ts.
    const root = join(__dirname, '..', '..', '..');
    const service = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(service.dependencies.pdfkit).toBe('0.20.2');
    const installed = JSON.parse(
      readFileSync(join(dirname(require.resolve('pdfkit')), '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe('0.20.2');
  });

  it('mises en forme gardées identiques à celles de fontkit sur le texte entier', () => {
    // Accents, espaces fines insécables, apostrophes typographiques, chiffres, crénages (« AV »,
    // « r. »), mots que les ligatures fusionneraient (« Koffi »), tabulations et espaces doubles.
    const corpus = [
      'L’huissier a constaté, le 12/05/2026 à 11:05:42, une créance de 150\u202f000 FCFA (12,5\u202f%).',
      '« Koffi », officiel, effectif, affiche ; AVANCE, Tél. +229 01 90 00 00 00 — r. f. W. Y. T.',
      'Échéance\tà\tvenir  : 1/2, 3,14, -5, 100%, 09:00:00 · remis · lu · échec de remise',
      'Anticonstitutionnellement re\u00adcouvrement mot\u200bsans\u200bespace a\u00a0b c\u2011d',
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const DIGITS = '0123456789:/.,%+-';
    const LETTERS = "abcdefghijklmnopqrstuvwxyzéèêàçœÉÀAVTWYLOfil’'«»;!?()–—…\u202f\u00a0";
    const word = (alphabet: string, length: number) =>
      Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    for (let index = 0; index < 800; index += 1) corpus.push(word(DIGITS, 3 + (index % 12)));
    for (let index = 0; index < 300; index += 1) {
      const words = Array.from({ length: 1 + (index % 9) }, (_, rank) =>
        word(rank % 2 ? DIGITS : DIGITS + LETTERS, 1 + Math.floor(random() * 10)),
      );
      corpus.push(words.join(index % 5 ? ' ' : '  '));
    }
    const signature = (run: LayoutRun) =>
      JSON.stringify([
        run.advanceWidth,
        run.glyphs.map((glyph) => [glyph.id, glyph.advanceWidth, glyph.codePoints]),
        run.positions,
      ]);
    const fonts = join(__dirname, '..', '..', '..', 'assets', 'fonts');
    for (const file of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']) {
      const doc = new PDFKitDocument();
      doc.registerFont('font', join(fonts, file));
      doc.font('font');
      const font = (doc as unknown as { _font: EmbeddedFont })._font;
      // Référence : fontkit sur le texte entier, comme PDFKit sans cache.
      const reference = corpus.map((line) => font.layoutRun(line, FEATURES));
      const expected = reference.map(signature);
      const widths = reference.map((run) => run.advanceWidth);
      cacheLayout(font, layoutStore());
      // Deux passages : mises en forme nouvelles, puis gardées ; tracé et mesure seule.
      for (let pass = 0; pass < 2; pass += 1) {
        expect(corpus.map((line) => signature(font.layout(line, FEATURES)))).toEqual(expected);
        expect(corpus.map((line) => font.layout(line, FEATURES, true).advanceWidth)).toEqual(widths);
      }
    }
  }, 60_000);

  it('produit un PDF A4 aux polices embarquées, identique pour un même contenu', async () => {
    const first = await renderer.render(agreement(3), meta);
    const second = await renderer.render(agreement(3), meta);
    expect(text(first.slice(0, 5))).toBe('%PDF-');
    expect(sha(first)).toBe(sha(second));
    expect(text(first)).toContain('/FontFile2');
    const parsed = await PDFDocument.load(first);
    expect(parsed.getPageCount()).toBe(2);
    const { width, height } = parsed.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    expect(parsed.getTitle()).toBe('Protocole');
  });

  it('continue sur plusieurs pages un long échéancier', async () => {
    const pdf = await renderer.render(agreement(60), meta);
    expect(await renderer.pageCount(pdf)).toBeGreaterThan(1);
  });

  it('ajoute la page de certificat sans modifier les pages d’origine', async () => {
    const original = await renderer.render(agreement(30), meta);
    const pages = await renderer.pageCount(original);
    const certificate = certificateContent({
      documentTitle: 'Protocole d’accord et échéancier de paiement',
      documentNumber: 'PAC-2026-000001',
      pageCount: pages,
      documentSha256: sha(original),
      signerName: 'Koffi Mensah',
      signerHasAccount: false,
      signerPhoneMasked: '+229********45',
      channel: 'whatsapp',
      signedAt: new Date('2026-11-09T10:05:00Z'),
      ip: '197.234.10.21',
      userAgent: 'Mozilla/5.0 (iPhone)',
      signatureRequestId: '0192f1c4-0000-7000-8000-000000000001',
      issuerName: 'Groupe KSP',
      timeZone: 'Africa/Porto-Novo',
    });
    const sealed = await renderer.appendCertificate(original, certificate, meta);
    expect(await renderer.pageCount(sealed)).toBe(pages + 1);

    // Le flux de contenu de chaque page d'origine est recopié tel quel.
    const before = await PDFDocument.load(original);
    const after = await PDFDocument.load(sealed);
    const streamOf = (doc: PDFDocument, index: number) => {
      const contents = doc.getPage(index).node.Contents();
      return contents ? Buffer.from(doc.context.lookup(contents)!.toString()).toString('hex') : '';
    };
    for (let index = 0; index < pages; index += 1) {
      expect(streamOf(after, index)).toBe(streamOf(before, index));
    }
  });
});
