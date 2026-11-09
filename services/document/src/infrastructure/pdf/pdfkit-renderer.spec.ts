import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { certificateContent } from '../../domain/certificate';
import { type DocumentContent } from '../../domain/content';
import { findTemplate } from '../../domain/templates/catalog';
import { PdfKitRenderer } from './pdfkit-renderer';

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

describe('PdfKitRenderer', () => {
  const renderer = new PdfKitRenderer(issuer);

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
