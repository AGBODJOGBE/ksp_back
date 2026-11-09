import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
import PDFDocument from 'pdfkit';
import { type PdfMeta, type PdfRenderer } from '../../application/ports';
import { type Block, type DocumentContent, type Issuer } from '../../domain/content';

/** Polices embarquées (Noto Sans, licence OFL) : rendu identique partout, accents compris. */
const FONTS_DIR = join(__dirname, '..', '..', '..', 'assets', 'fonts');

const COLORS = { text: '#1a1a1a', muted: '#5f6670', accent: '#1f3a5f', rule: '#c9ced6' } as const;
const MARGIN = { top: 92, bottom: 70, left: 56, right: 56 } as const;
const BODY = 10;

type Doc = PDFKit.PDFDocument;

/**
 * Rendu PDF avec PDFKit (ADR-044) : A4, en-tête de l'émetteur et numéro sur chaque page, pied de
 * page (mentions, pagination), polices embarquées et sous-ensemblées. Le rendu est déterministe
 * pour un même contenu et une même date. La page de certificat est produite à part puis ajoutée
 * aux pages d'origine par pdf-lib, qui recopie celles-ci sans les modifier.
 */
export class PdfKitRenderer implements PdfRenderer {
  private readonly regular: Buffer;
  private readonly bold: Buffer;

  constructor(private readonly issuer: Issuer) {
    this.regular = readFileSync(join(FONTS_DIR, 'NotoSans-Regular.ttf'));
    this.bold = readFileSync(join(FONTS_DIR, 'NotoSans-Bold.ttf'));
  }

  render(content: DocumentContent, meta: PdfMeta): Promise<Uint8Array> {
    return this.draw(content, meta, (page, total) => `Page ${page} / ${total}`);
  }

  async pageCount(pdf: Uint8Array): Promise<number> {
    return (await PdfLibDocument.load(pdf, { updateMetadata: false })).getPageCount();
  }

  async appendCertificate(
    original: Uint8Array,
    certificate: DocumentContent,
    meta: PdfMeta,
  ): Promise<Uint8Array> {
    const certificatePdf = await this.draw(certificate, meta, () => 'Certificat de signature');
    const document = await PdfLibDocument.load(original, { updateMetadata: false });
    const source = await PdfLibDocument.load(certificatePdf, { updateMetadata: false });
    const pages = await document.copyPages(source, source.getPageIndices());
    for (const page of pages) document.addPage(page);
    document.setModificationDate(meta.createdAt);
    return document.save({ useObjectStreams: false });
  }

  private draw(
    content: DocumentContent,
    meta: PdfMeta,
    footerLabel: (page: number, total: number) => string,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: MARGIN,
        bufferPages: true,
        autoFirstPage: true,
        info: {
          Title: meta.title,
          Author: this.issuer.name,
          Creator: `${this.issuer.name} — service document`,
          Producer: 'KSP document',
          CreationDate: meta.createdAt,
          ModDate: meta.createdAt,
        },
        lang: 'fr-FR',
        displayTitle: true,
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      doc.on('error', reject);
      try {
        doc.registerFont('regular', this.regular);
        doc.registerFont('bold', this.bold);
        this.title(doc, content);
        for (const block of content.blocks) this.block(doc, block);
        this.frame(doc, content, footerLabel);
        doc.end();
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  private get width(): number {
    return 595.28 - MARGIN.left - MARGIN.right;
  }

  /** Saute à la page suivante si la hauteur demandée ne tient plus. */
  private ensure(doc: Doc, height: number): void {
    if (doc.y + height > doc.page.height - MARGIN.bottom) doc.addPage();
  }

  private title(doc: Doc, content: DocumentContent): void {
    doc.font('bold').fontSize(16).fillColor(COLORS.accent);
    doc.text(content.title, MARGIN.left, MARGIN.top, { width: this.width });
    doc.moveDown(0.3);
    doc.font('regular').fontSize(BODY).fillColor(COLORS.muted);
    doc.text(`N° ${content.number}`, { width: this.width });
    doc.text(content.dateLine, { width: this.width });
    doc.moveDown(0.8);
    doc.fillColor(COLORS.text);
  }

  private block(doc: Doc, block: Block): void {
    const x = MARGIN.left;
    switch (block.kind) {
      case 'heading': {
        doc.moveDown(0.6);
        this.ensure(doc, 40);
        doc.font('bold').fontSize(11.5).fillColor(COLORS.accent);
        doc.text(block.text, x, doc.y, { width: this.width });
        doc.moveDown(0.3).fillColor(COLORS.text);
        return;
      }
      case 'paragraph': {
        doc
          .font(block.strong ? 'bold' : 'regular')
          .fontSize(BODY)
          .fillColor(COLORS.text);
        doc.text(block.text, x, doc.y, { width: this.width, align: 'justify', lineGap: 2 });
        doc.moveDown(0.5);
        return;
      }
      case 'list': {
        doc.font('regular').fontSize(BODY);
        for (const item of block.items) {
          const height = doc.heightOfString(item, { width: this.width - 14, lineGap: 2 });
          this.ensure(doc, height);
          const y = doc.y;
          doc.text('•', x + 2, y, { width: 10 });
          doc.text(item, x + 14, y, { width: this.width - 14, lineGap: 2 });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.3);
        return;
      }
      case 'fields': {
        const labelWidth = 140;
        const valueWidth = this.width - labelWidth - 10;
        doc.fontSize(BODY);
        for (const [label, value] of block.rows) {
          doc.font('regular');
          const height = Math.max(
            doc.heightOfString(label, { width: labelWidth }),
            doc.heightOfString(value, { width: valueWidth, lineGap: 1 }),
          );
          this.ensure(doc, height);
          const y = doc.y;
          doc.fillColor(COLORS.muted).text(label, x, y, { width: labelWidth });
          doc.fillColor(COLORS.text).text(value, x + labelWidth + 10, y, { width: valueWidth, lineGap: 1 });
          doc.y = y + height + 4;
        }
        doc.moveDown(0.3);
        return;
      }
      case 'table': {
        this.table(doc, block);
        return;
      }
      case 'signatures': {
        doc.moveDown(1);
        this.ensure(doc, 90);
        const gap = 20;
        const count = block.parties.length;
        const width = (this.width - gap * (count - 1)) / count;
        const y = doc.y;
        block.parties.forEach((party, index) => {
          const left = x + index * (width + gap);
          doc.lineWidth(0.5).strokeColor(COLORS.rule).rect(left, y, width, 80).stroke();
          doc
            .font('bold')
            .fontSize(BODY)
            .fillColor(COLORS.text)
            .text(party.role, left + 8, y + 8, { width: width - 16 });
          doc.font('regular').text(party.name, left + 8, doc.y + 2, { width: width - 16 });
          doc
            .fontSize(8.5)
            .fillColor(COLORS.muted)
            .text(party.note, left + 8, y + 60, { width: width - 16 });
        });
        doc.fillColor(COLORS.text).fontSize(BODY);
        doc.x = x;
        doc.y = y + 92;
        return;
      }
    }
  }

  private table(doc: Doc, block: Extract<Block, { kind: 'table' }>): void {
    const x = MARGIN.left;
    const columns = block.columns.length;
    // Première colonne étroite (numéro), les autres se partagent la largeur.
    const first = columns > 2 ? 70 : this.width / columns;
    const rest = columns > 1 ? (this.width - first) / (columns - 1) : this.width;
    const widths = block.columns.map((_, index) => (index === 0 ? first : rest));
    const align = (index: number) => block.align?.[index] ?? 'left';
    const row = (cells: readonly string[], font: 'regular' | 'bold') => {
      doc.font(font).fontSize(BODY);
      const height =
        Math.max(...cells.map((cell, index) => doc.heightOfString(cell, { width: widths[index]! - 8 }))) + 6;
      this.ensure(doc, height);
      const y = doc.y;
      let left = x;
      cells.forEach((cell, index) => {
        doc
          .fillColor(COLORS.text)
          .text(cell, left + 4, y + 3, { width: widths[index]! - 8, align: align(index) });
        left += widths[index]!;
      });
      doc
        .lineWidth(0.5)
        .strokeColor(COLORS.rule)
        .moveTo(x, y + height)
        .lineTo(x + this.width, y + height)
        .stroke();
      doc.x = x;
      doc.y = y + height;
    };
    row(block.columns, 'bold');
    for (const cells of block.rows) row(cells, 'regular');
    if (block.totalRow) row(block.totalRow, 'bold');
    doc.moveDown(0.6);
  }

  /** En-tête et pied de page de chaque page, écrits une fois le contenu mis en page. */
  private frame(
    doc: Doc,
    content: DocumentContent,
    footerLabel: (page: number, total: number) => string,
  ): void {
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      // Écrire hors des marges sans provoquer de saut de page.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const width = this.width;
      doc
        .font('bold')
        .fontSize(12)
        .fillColor(COLORS.accent)
        .text(this.issuer.name.toUpperCase(), MARGIN.left, 34, {
          width: width / 2,
          lineBreak: false,
        });
      doc
        .font('regular')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(this.issuer.address, MARGIN.left, 52, {
          width: width / 2,
          lineBreak: false,
        });
      doc.text(content.number, MARGIN.left + width / 2, 38, {
        width: width / 2,
        align: 'right',
        lineBreak: false,
      });
      doc
        .lineWidth(0.7)
        .strokeColor(COLORS.accent)
        .moveTo(MARGIN.left, 70)
        .lineTo(MARGIN.left + width, 70)
        .stroke();

      const footerY = doc.page.height - 50;
      doc
        .lineWidth(0.5)
        .strokeColor(COLORS.rule)
        .moveTo(MARGIN.left, footerY - 6)
        .lineTo(MARGIN.left + width, footerY - 6)
        .stroke();
      const legal = [this.issuer.name, this.issuer.legalDetails].filter(Boolean).join(' — ');
      doc
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(legal, MARGIN.left, footerY, {
          width: width * 0.7,
          lineBreak: false,
        });
      doc.text(footerLabel(index - range.start + 1, range.count), MARGIN.left + width * 0.7, footerY, {
        width: width * 0.3,
        align: 'right',
        lineBreak: false,
      });
      doc.page.margins.bottom = bottom;
    }
  }
}
