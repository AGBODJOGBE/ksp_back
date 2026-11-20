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
/**
 * Options de texte communes : crénage sans ligatures (« ffi » resterait un seul glyphe, et le texte
 * copié ou recherché dans le PDF perdrait des lettres : « Kof » pour « Koffi »).
 */
export const FEATURES = { liga: false, clig: false, dlig: false };
const TEXT = { features: FEATURES } as unknown as PDFKit.Mixins.TextOptions;

type Doc = PDFKit.PDFDocument;

/** Partie utilisée de la police embarquée de PDFKit (`EmbeddedFont`, non typée). */
export interface GlyphPosition {
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}
/** Ce que PDFKit lit d'un glyphe : son numéro, sa chasse et ses caractères (texte copiable). */
export interface Glyph {
  id: number;
  advanceWidth: number;
  codePoints: number[];
}
export interface LayoutRun {
  glyphs: Glyph[];
  positions: GlyphPosition[];
  advanceWidth: number;
}

/**
 * Mises en forme gardées d'un document à l'autre, par police : elles ne dépendent que du fichier de
 * police. Copies en données simples (les glyphes de fontkit retiendraient la police d'un ancien
 * document) ; vidées au-delà de `GLYPH_LIMIT` glyphes gardés. La borne porte sur les glyphes et non
 * sur les mots : 20 000 mots de 250 caractères sans espace occupaient environ 800 Mo par police.
 */
export interface LayoutStore {
  words: Map<string, LayoutRun>;
  pairs: Map<string, boolean>;
  /** Glyphes gardés dans `words` (environ 130 octets chacun). */
  glyphs: number;
}
/** Environ 20 Mo par police au plus. */
const GLYPH_LIMIT = 150_000;

export function layoutStore(): LayoutStore {
  return { words: new Map(), pairs: new Map(), glyphs: 0 };
}

/** Méthodes internes de PDFKit 0.20.2 utilisées ici : un changement de version doit échouer net. */
function pdfkitInternal(name: string): never {
  throw new Error(
    `PDFKit : méthode interne « ${name} » absente. Le rendu dépend de PDFKit 0.20.2 ` +
      '(voir pdfkit-renderer.ts) ; revoir ce fichier avant de changer de version.',
  );
}

function plain(run: LayoutRun): LayoutRun {
  return {
    glyphs: run.glyphs.map(({ id, advanceWidth, codePoints }) => ({ id, advanceWidth, codePoints })),
    positions: run.positions.map((position) => ({ ...position })),
    advanceWidth: run.advanceWidth,
  };
}
export interface EmbeddedFont {
  layout(text: string, features?: unknown, onlyWidth?: boolean): LayoutRun;
  layoutRun(text: string, features?: unknown): LayoutRun;
}

/** Mots composés caractère par caractère : chiffres et ponctuation des dates, heures, numéros. */
const COMPOSABLE = /^[0-9:/.,%+-]+[ \t]?$/;

/** Deux caractères mis en forme ensemble donnent-ils la même chose que séparément ? */
function independent(pair: LayoutRun, first: LayoutRun, second: LayoutRun): boolean {
  const alone = [...first.glyphs, ...second.glyphs];
  const apart = [...first.positions, ...second.positions];
  return (
    pair.glyphs.length === alone.length &&
    pair.glyphs.every((glyph, index) => glyph.id === alone[index]!.id) &&
    pair.positions.every((position, index) => {
      const other = apart[index]!;
      return (
        position.xAdvance === other.xAdvance &&
        position.yAdvance === other.yAdvance &&
        position.xOffset === other.xOffset &&
        position.yOffset === other.yOffset
      );
    })
  );
}

/**
 * PDFKit ne garde la mise en forme d'un mot en cache que sans option de police : avec `features`
 * (ligatures désactivées), chaque mesure et chaque tracé repassait tout le texte par fontkit, soit
 * environ 20 ms par ligne de tableau. On rétablit pour nos options le cache par mot de PDFKit,
 * découpé de la même façon (un mot et l'espace qui le suit). Les résultats ne sont jamais modifiés
 * par PDFKit (il copie une position avant de l'ajuster), comme pour son propre cache.
 *
 * Un mot nouveau coûte encore une mise en forme par fontkit (environ 0,3 ms), et chaque ligne d'un
 * journal en apporte (numéro, heure). Un mot fait de chiffres et de ponctuation est donc composé à
 * partir de ses caractères, quand chaque paire voisine est vérifiée sans interaction (ni crénage
 * ni substitution) : le résultat est identique glyphe pour glyphe, tant que la police n'a pas de
 * règle portant sur trois caractères ou plus parmi ceux-là (vrai pour Noto Sans, vérifié par le test
 * d'exactitude du spec, à relancer si la police change). Mots et verdicts des paires sont gardés
 * d'un document à l'autre (`store`) : la sortie n'en dépend pas, et deux rendus simultanés ne
 * s'entremêlent pas (toute la mise en page d'un document est synchrone). Exportée pour ce test.
 */
export function cacheLayout(font: EmbeddedFont, store: LayoutStore): void {
  if (typeof font.layout !== 'function') pdfkitInternal('EmbeddedFont.layout');
  if (typeof font.layoutRun !== 'function') pdfkitInternal('EmbeddedFont.layoutRun');
  const layout = font.layout.bind(font);
  const { words: cache, pairs } = store;
  const remember = (word: string, run: LayoutRun) => {
    if (store.glyphs + run.glyphs.length > GLYPH_LIMIT) {
      cache.clear();
      store.glyphs = 0;
    }
    cache.set(word, run);
    store.glyphs += run.glyphs.length;
    return run;
  };
  const shape = (word: string) => cache.get(word) ?? remember(word, plain(font.layoutRun(word, FEATURES)));
  const composable = (word: string) => {
    for (let index = 1; index < word.length; index += 1) {
      const pair = word.slice(index - 1, index + 1);
      let verdict = pairs.get(pair);
      if (verdict === undefined) {
        verdict = independent(font.layoutRun(pair, FEATURES), shape(pair[0]!), shape(pair[1]!));
        pairs.set(pair, verdict);
      }
      if (!verdict) return false;
    }
    return true;
  };
  const run = (word: string): LayoutRun => {
    const cached = cache.get(word);
    if (cached) return cached;
    if (word.length < 3 || !COMPOSABLE.test(word) || !composable(word)) return shape(word);
    const parts = [...word].map(shape);
    return remember(word, {
      glyphs: parts.flatMap((part) => part.glyphs),
      positions: parts.flatMap((part) => part.positions),
      advanceWidth: parts.reduce((total, part) => total + part.advanceWidth, 0),
    });
  };
  font.layout = (text, features, onlyWidth) => {
    if (features !== FEATURES) return layout(text, features, onlyWidth);
    const glyphs: LayoutRun['glyphs'] = [];
    const positions: GlyphPosition[] = [];
    let advanceWidth = 0;
    let start = 0;
    for (let index = 0; index <= text.length; index += 1) {
      const end = index === text.length;
      if (!end && text[index] !== ' ' && text[index] !== '\t') continue;
      const stop = end ? index : index + 1;
      if (stop === start) continue;
      const word = run(text.slice(start, stop));
      if (!onlyWidth) {
        for (const glyph of word.glyphs) glyphs.push(glyph);
        for (const position of word.positions) positions.push(position);
      }
      advanceWidth += word.advanceWidth;
      start = stop;
    }
    return { glyphs, positions, advanceWidth };
  };
}

/** Découpage interne de PDFKit (`_text` avec son `LineWrapper`), non typé. */
interface TextInternals {
  _text(text: string, x: number, y: number, options: object, line: (text: string) => void): void;
}

/**
 * Lignes d'un texte découpé à la largeur donnée, par le découpeur de PDFKit lui-même (règles de
 * coupure Unicode, mots trop longs coupés) : exactement les lignes que `text` aurait tracées, sans
 * tracer. C'est ce que fait `heightOfString`, qui ne rend que la hauteur.
 */
function wrapLines(doc: Doc, text: string, width: number, lineHeight: number): string[] {
  const lines: string[] = [];
  const { x, y } = doc;
  const internals = doc as unknown as Partial<TextInternals>;
  if (typeof internals._text !== 'function') pdfkitInternal('PDFDocument._text');
  (doc as unknown as TextInternals)._text(text, x, y, { ...TEXT, width, height: Infinity }, (line) => {
    lines.push(line);
    doc.y += lineHeight;
  });
  doc.x = x;
  doc.y = y;
  return lines;
}

/**
 * Rendu PDF avec PDFKit (ADR-044) : A4, en-tête de l'émetteur et numéro sur chaque page, pied de
 * page (mentions, pagination), polices embarquées et sous-ensemblées. Le rendu est déterministe
 * pour un même contenu et une même date. La page de certificat est produite à part puis ajoutée
 * aux pages d'origine par pdf-lib, qui recopie celles-ci sans les modifier.
 */
export class PdfKitRenderer implements PdfRenderer {
  private readonly regular: Buffer;
  private readonly bold: Buffer;
  /** Mises en forme gardées d'un document à l'autre, par police (voir `cacheLayout`). */
  private readonly layouts: Record<'regular' | 'bold', LayoutStore> = {
    regular: layoutStore(),
    bold: layoutStore(),
  };

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
        for (const [name, data] of [
          ['bold', this.bold],
          ['regular', this.regular],
        ] as const) {
          doc.registerFont(name, data);
          doc.font(name);
          cacheLayout((doc as unknown as { _font: EmbeddedFont })._font, this.layouts[name]);
        }
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
    doc.text(content.title, MARGIN.left, MARGIN.top, { ...TEXT, width: this.width });
    doc.moveDown(0.3);
    doc.font('regular').fontSize(BODY).fillColor(COLORS.muted);
    doc.text(`N° ${content.number}`, { ...TEXT, width: this.width });
    doc.text(content.dateLine, { ...TEXT, width: this.width });
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
        doc.text(block.text, x, doc.y, { ...TEXT, width: this.width });
        doc.moveDown(0.3).fillColor(COLORS.text);
        return;
      }
      case 'paragraph': {
        doc
          .font(block.strong ? 'bold' : 'regular')
          .fontSize(BODY)
          .fillColor(COLORS.text);
        doc.text(block.text, x, doc.y, { ...TEXT, width: this.width, align: 'justify', lineGap: 2 });
        doc.moveDown(0.5);
        return;
      }
      case 'list': {
        doc.font('regular').fontSize(BODY);
        for (const item of block.items) {
          const height = doc.heightOfString(item, { ...TEXT, width: this.width - 14, lineGap: 2 });
          this.ensure(doc, height);
          const y = doc.y;
          doc.text('•', x + 2, y, { ...TEXT, width: 10 });
          doc.text(item, x + 14, y, { ...TEXT, width: this.width - 14, lineGap: 2 });
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
            doc.heightOfString(label, { ...TEXT, width: labelWidth }),
            doc.heightOfString(value, { ...TEXT, width: valueWidth, lineGap: 1 }),
          );
          this.ensure(doc, height);
          const y = doc.y;
          doc.fillColor(COLORS.muted).text(label, x, y, { ...TEXT, width: labelWidth });
          doc
            .fillColor(COLORS.text)
            .text(value, x + labelWidth + 10, y, { ...TEXT, width: valueWidth, lineGap: 1 });
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
        // Une partie seule garde la largeur d'une colonne sur deux.
        const width = (this.width - gap * (Math.max(count, 2) - 1)) / Math.max(count, 2);
        const y = doc.y;
        block.parties.forEach((party, index) => {
          const left = x + index * (width + gap);
          doc.lineWidth(0.5).strokeColor(COLORS.rule).rect(left, y, width, 80).stroke();
          doc
            .font('bold')
            .fontSize(BODY)
            .fillColor(COLORS.text)
            .text(party.role, left + 8, y + 8, { ...TEXT, width: width - 16 });
          doc.font('regular').text(party.name, left + 8, doc.y + 2, { ...TEXT, width: width - 16 });
          doc
            .fontSize(8.5)
            .fillColor(COLORS.muted)
            .text(party.note, left + 8, y + 60, { ...TEXT, width: width - 16 });
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
    // Chaque cellule est découpée en lignes une seule fois (mesure), puis chaque ligne est tracée
    // telle quelle, sans repasser par le découpage de PDFKit. Hauteur d'une ligne par police :
    // celle que PDFKit ajoute entre deux lignes (`heightOfString` d'une ligne).
    const lineHeights = { regular: 0, bold: 0 };
    for (const font of ['regular', 'bold'] as const) {
      doc.font(font).fontSize(BODY);
      lineHeights[font] = doc.heightOfString('X', { ...TEXT, width: this.width });
    }

    interface Line {
      text: string;
      /** Décalage depuis le bord gauche de la cellule (alignement à droite). */
      shift: number;
    }
    interface Row {
      cells: Line[][];
      font: 'regular' | 'bold';
      height: number;
    }
    const prepare = (texts: readonly string[], font: 'regular' | 'bold'): Row => {
      doc.font(font).fontSize(BODY);
      const cells = texts.map((text, index) => {
        const available = widths[index]! - 8;
        const right = align(index) === 'right';
        // Même position que PDFKit : à droite, largeur du texte sans ses espaces finales retirée.
        const place = (line: string, width?: number): Line => ({
          text: line,
          shift: right ? available - (width ?? doc.widthOfString(line.replace(/\s+$/, ''), TEXT)) : 0,
        });
        const width = text.includes('\n') ? Infinity : doc.widthOfString(text, TEXT);
        if (width <= available) return [place(text, right ? undefined : width)];
        return wrapLines(doc, text, available, lineHeights[font]).map((line) => place(line));
      });
      const tallest = Math.max(1, ...cells.map((lines) => lines.length));
      return { cells, font, height: tallest * lineHeights[font] + 6 };
    };
    const draw = (row: Row) => {
      doc.font(row.font).fontSize(BODY).fillColor(COLORS.text);
      const y = doc.y;
      const step = lineHeights[row.font];
      let left = x;
      row.cells.forEach((lines, index) => {
        lines.forEach((line, rank) => {
          if (line.text === '') return;
          doc.text(line.text, left + 4 + line.shift, y + 3 + rank * step, { ...TEXT, lineBreak: false });
        });
        left += widths[index]!;
      });
      doc
        .lineWidth(0.5)
        .strokeColor(COLORS.rule)
        .moveTo(x, y + row.height)
        .lineTo(x + this.width, y + row.height)
        .stroke();
      doc.x = x;
      doc.y = y + row.height;
    };
    // L'en-tête reste avec la première ligne, et se répète en haut de chaque nouvelle page
    // (long échéancier, journal de preuve).
    const header = prepare(block.columns, 'bold');
    const rows = block.rows.map((cells) => prepare(cells, 'regular'));
    if (block.totalRow) rows.push(prepare(block.totalRow, 'bold'));
    this.ensure(doc, header.height + (rows[0]?.height ?? 0));
    draw(header);
    for (const row of rows) {
      if (doc.y + row.height > doc.page.height - MARGIN.bottom) {
        doc.addPage();
        draw(header);
      }
      draw(row);
    }
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
          ...TEXT,
          width: width / 2,
          lineBreak: false,
        });
      doc
        .font('regular')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(this.issuer.address, MARGIN.left, 52, {
          ...TEXT,
          width: width / 2,
          lineBreak: false,
        });
      doc.text(content.number, MARGIN.left + width / 2, 38, {
        ...TEXT,
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
          ...TEXT,
          width: width * 0.7,
          lineBreak: false,
        });
      doc.text(footerLabel(index - range.start + 1, range.count), MARGIN.left + width * 0.7, footerY, {
        ...TEXT,
        width: width * 0.3,
        align: 'right',
        lineBreak: false,
      });
      doc.page.margins.bottom = bottom;
    }
  }
}
