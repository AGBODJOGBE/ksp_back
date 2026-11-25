import { deflateRawSync } from 'node:zlib';
import { type fileV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { FileSpreadsheetReader, importRows } from './file-spreadsheet-reader';
import { excelSerialToDay, isZip, parseCsv, parseXlsx, SpreadsheetError } from './spreadsheet';

const LIMITS = { maxRows: 1_001, maxColumns: 12, maxPartBytes: 1024 * 1024 };

/** Archive ZIP minimale (parties compressées, sans somme de contrôle : le lecteur ne la vérifie pas). */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content, 'utf8'));
    const fileName = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(fileName.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(Buffer.byteLength(content), 24);
    header.writeUInt16LE(fileName.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, fileName, data);
    central.push(header, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const workbook = (sheet: string) =>
  zip({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Factures" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Type</t></si><si><t>company</t></si><si><r><t>SARL </t></r><r><t>Atlantique &amp; Fils</t></r></si></sst>',
    'xl/styles.xml':
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': sheet,
  });

describe('lecture des tableurs d’import (R-SD-01)', () => {
  describe('CSV', () => {
    it('détecte le séparateur, lit les guillemets, ignore les lignes vides', () => {
      const csv =
        '\uFEFFType;Nom;Prénoms\r\ncompany;"SARL ""Atlantique""; Fils";\r\n;;\r\nperson;Dossou;"Koffi\nJean"\r\n';
      expect(parseCsv(Buffer.from(csv, 'utf8'), LIMITS)).toEqual([
        { number: 1, cells: ['Type', 'Nom', 'Prénoms'] },
        { number: 2, cells: ['company', 'SARL "Atlantique"; Fils', ''] },
        { number: 4, cells: ['person', 'Dossou', 'Koffi\nJean'] },
      ]);
    });

    it('lit un export Windows-1252 et refuse un fichier trop long', () => {
      const latin = Buffer.from([0x4e, 0x6f, 0x6d, 0x2c, 0x50, 0x72, 0xe9, 0x6e, 0x6f, 0x6d]); // « Nom,Prénom »
      expect(parseCsv(latin, LIMITS)[0]!.cells).toEqual(['Nom', 'Prénom']);
      const long = Array.from({ length: 5 }, (_, i) => `l${i};x`).join('\n');
      expect(() => parseCsv(Buffer.from(long), { ...LIMITS, maxRows: 3 })).toThrow(SpreadsheetError);
    });
  });

  describe('XLSX', () => {
    it('lit textes partagés et en ligne, nombres, dates au format date, cellules manquantes', () => {
      const buffer = workbook(
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Nom</t></is></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c><c r="E3"><v>97000201</v></c>' +
          '<c r="I3"><v>150000</v></c><c r="J3" s="1"><v>46296</v></c></row>' +
          '<row r="4"/>' +
          '</sheetData></worksheet>',
      );
      expect(isZip(buffer)).toBe(true);
      expect(parseXlsx(buffer, LIMITS)).toEqual([
        { number: 1, cells: ['Type', 'Nom'] },
        {
          number: 3,
          cells: [
            'company',
            'SARL Atlantique & Fils',
            '',
            '',
            '97000201',
            '',
            '',
            '',
            '150000',
            '2026-10-01',
          ],
        },
      ]);
    });

    it('refuse une archive illisible ou une partie trop grande une fois décompressée', () => {
      expect(() => parseXlsx(Buffer.from('PK\u0003\u0004pas une archive'), LIMITS)).toThrow(SpreadsheetError);
      const big = workbook(
        `<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(2_000)}</sheetData></worksheet>`,
      );
      expect(() => parseXlsx(big, { ...LIMITS, maxPartBytes: 10_000 })).toThrow(/trop volumineux/);
    });

    it('convertit les numéros de série d’Excel en jours', () => {
      expect(excelSerialToDay(46296)).toBe('2026-10-01');
      expect(excelSerialToDay(61)).toBe('1900-03-01');
      expect(excelSerialToDay(-3)).toBeNull();
    });
  });

  describe('lignes du modèle', () => {
    it('saute l’en-tête, numérote depuis lui, rend le zéro du « 01 » et lit les dates JJ/MM/AAAA', () => {
      const rows = importRows([
        { number: 2, cells: ['Type', 'Nom'] },
        {
          number: 3,
          cells: ['company', 'SARL Atlantique', '', '', '197000201', '', '', 'A-1', '100000', '1/10/2026'],
        },
      ]);
      expect(rows).toEqual([
        {
          row: 1,
          values: expect.objectContaining({
            debtorKind: 'company',
            debtorPhone: '0197000201',
            invoiceReference: 'A-1',
            dueDate: '2026-10-01',
            nature: '',
          }),
        },
      ]);
    });

    it('refuse un fichier sans en-tête', () => {
      expect(() => importRows([{ number: 1, cells: ['person', 'Dossou'] }])).toThrow(
        expect.objectContaining({
          code: 'RECOVERY_IMPORT_FILE_INVALID',
          details: { reason: 'header_missing' },
        }),
      );
    });
  });

  describe('lecture chez file', () => {
    const caller = {
      call: async (_name: string, invoke: (metadata: never) => unknown) => {
        const result = invoke({} as never);
        return isObservable(result) ? firstValueFrom(result) : result;
      },
    } as unknown as GrpcCaller;

    it('rattache le fichier à l’import, le lit par l’adresse présignée et le contrôle', async () => {
      const calls: string[] = [];
      const client = {
        attachFile: (request: fileV1.AttachFileRequest) => {
          calls.push(`attach:${request.subject?.type}:${request.ownerId}`);
          return of({ file: { id: request.fileId } });
        },
        createDownloadUrl: () => {
          calls.push('url');
          return of({
            file: { sizeBytes: 120 },
            download: { url: 'https://stockage.local/f', expiresAt: '' },
          });
        },
      } as unknown as fileV1.FileInternalServiceClient;
      const csv = 'Type;Nom\ncompany;SARL Atlantique';
      const fetcher = (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;
      const reader = new FileSpreadsheetReader(client, caller, fetcher);
      const rows = await reader.read({
        fileId: 'f-1',
        subject: { type: 'recovery_case_import', id: 'i-1' },
        ownerId: 'u-1',
      });
      expect(calls).toEqual(['attach:recovery_case_import:u-1', 'url']);
      expect(rows).toEqual([{ row: 1, values: expect.objectContaining({ debtorName: 'SARL Atlantique' }) }]);

      const failing = new FileSpreadsheetReader(
        client,
        caller,
        (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      );
      await expect(
        failing.read({ fileId: 'f-1', subject: { type: 'recovery_case_import', id: 'i-1' }, ownerId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'RECOVERY_DEPENDENCY_UNAVAILABLE' });
    });
  });
});
