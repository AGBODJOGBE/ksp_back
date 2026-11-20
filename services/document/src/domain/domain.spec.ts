import { certificateContent } from './certificate';
import { decideSend, DEFAULT_CODE_POLICY, normalizeCode } from './code-policy';
import { canCancel, canRequestSignature, formatDocumentNumber } from './document';
import { addDays, formatAmount, formatCalendarDate, formatDateTime, formatPercent } from './format';
import { maskPhone, parseEmail, parsePhone } from './phone';
import { cleanIp, cleanUserAgent, effectiveStatus, type SignatureRequestRecord } from './signature';
import { canProduce, findTemplate, templateCatalog } from './templates/catalog';
import { MAX_ENTRIES, MAX_ENTRIES_BYTES } from './templates/recovery-evidence-log.v1';

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
  it('catalogue : neuf modèles en version 1, préfixes uniques, dernière version par défaut', () => {
    expect(templateCatalog().map((t) => `${t.code}@${t.version}`)).toEqual([
      'recovery_mandate@1',
      'recovery_formal_notice@1',
      'recovery_settlement_agreement@1',
      'recovery_settlement_certificate@1',
      'recovery_fee_quote@1',
      'recovery_evidence_log@1',
      'recovery_statement@1',
      'recovery_receipt@1',
      'generic@1',
    ]);
    const prefixes = templateCatalog().map((t) => t.numberPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const t of templateCatalog().filter((item) => item.code.startsWith('recovery_'))) {
      expect(t.services).toEqual(['recovery']);
    }
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

  it('attestation de solde : total des paiements, remise seulement pour un accord transactionnel', () => {
    const entry = findTemplate('recovery_settlement_certificate', 1)!;
    expect(entry.info).toMatchObject({ numberPrefix: 'ATS', signature: 'none' });
    const base = {
      caseReference: 'RC-000123',
      creditor: { name: 'SARL Bénin Propre' },
      debtor: { name: 'Koffi Mensah' },
      claim: { cause: 'Facture n° 18 impayée' },
      closure: 'paid_in_full',
      totalPaid: 150000,
      settledOn: '2026-12-05',
      payments: [
        { date: '2026-11-05', amount: 100000 },
        { date: '2026-12-05', amount: 50000 },
      ],
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const text = JSON.stringify(ok.document.build({ ...context, number: 'ATS-2026-000001' }));
      expect(text).toContain(formatAmount(150000));
      expect(text).toContain('soldé au 5 décembre 2026');
      expect(text).toContain('Koffi Mensah a réglé la somme totale');
    }
    expect(entry.prepare({ ...base, totalPaid: 140000 })).toEqual({ ok: false, fields: ['payments'] });
    expect(entry.prepare({ ...base, waivedAmount: 1000 })).toEqual({ ok: false, fields: ['waivedAmount'] });
    expect(entry.prepare({ ...base, closure: 'settlement_executed' })).toEqual({
      ok: false,
      fields: ['waivedAmount'],
    });
    const settlement = entry.prepare({ ...base, closure: 'settlement_executed', waivedAmount: 30000 });
    expect(settlement.ok && JSON.stringify(settlement.document.build(context))).toContain(
      formatAmount(30000),
    );
    expect(entry.prepare({ ...base, payments: [{ date: '2026-12-06', amount: 150000 }] })).toEqual({
      ok: false,
      fields: ['payments.0.date'],
    });
    expect(entry.prepare({ ...base, intrus: 1 }).ok).toBe(false);
  });

  it('devis des frais : total des lignes, provision au plus égale au total, signature facultative', () => {
    const entry = findTemplate('recovery_fee_quote', 1)!;
    expect(entry.info).toMatchObject({ numberPrefix: 'DEV', signature: 'optional' });
    const base = {
      caseReference: 'RC-000123',
      creditor: { name: 'SARL Bénin Propre' },
      debtor: { name: 'Koffi Mensah' },
      stage: 'bailiff',
      partner: { kind: 'bailiff', name: 'Me K. Adjovi', office: 'Office de Cotonou' },
      amountDue: 500000,
      lines: [
        { category: 'bailiff', label: 'Sommation de payer', amount: 35000 },
        { category: 'bailiff', label: 'Saisie conservatoire', amount: 60000 },
      ],
      total: 95000,
      provision: 50000,
      acceptBy: '2026-12-10',
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.document.title).toBe('Devis des frais : intervention d’un huissier');
      const blocks = ok.document.build({ ...context, number: 'DEV-2026-000001' });
      expect(blocks.find((block) => block.kind === 'table')).toMatchObject({
        totalRow: ['Total', '', '', formatAmount(95000)],
      });
      expect(JSON.stringify(blocks)).toContain('10 décembre 2026');
    }
    expect(entry.prepare({ ...base, total: 90000 })).toEqual({ ok: false, fields: ['lines'] });
    expect(entry.prepare({ ...base, provision: 95001 })).toEqual({ ok: false, fields: ['provision'] });
    expect(entry.prepare({ ...base, lines: [] }).ok).toBe(false);
    expect(entry.prepare({ ...base, stage: 'amicable' })).toEqual({ ok: false, fields: ['stage'] });
    expect(entry.prepare({ ...base, partner: { ...base.partner, kind: 'lawyer' } })).toEqual({
      ok: false,
      fields: ['partner.kind'],
    });
    expect(
      entry.prepare({ ...base, stage: 'litigation', partner: { ...base.partner, kind: 'lawyer' } }).ok,
    ).toBe(true);
    expect(entry.prepare({ ...base, provision: 0 }).ok).toBe(false);
  });

  it('journal de preuve : ordre chronologique, heures du Bénin, statut de remise', () => {
    const entry = findTemplate('recovery_evidence_log', 1)!;
    expect(entry.info).toMatchObject({ numberPrefix: 'JDP', signature: 'none' });
    const first = {
      at: '2026-10-02T08:00:00Z',
      action: 'Notification du mandat',
      actor: 'Système',
      channel: 'WhatsApp',
      delivery: 'read',
    };
    const second = {
      at: '2026-10-05T14:30:00Z',
      action: 'Appel sortant',
      actor: 'A. Hounsou, chargé de recouvrement',
      channel: 'Appel',
      outcome: 'Promesse de paiement au 30/10',
    };
    const base = {
      caseReference: 'RC-000123',
      creditor: { name: 'SARL Bénin Propre' },
      debtor: { name: 'Koffi Mensah' },
      openedOn: '2026-10-01',
      currentStage: 'Mise en demeure',
      entries: [first, second],
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const blocks = ok.document.build({ ...context, number: 'JDP-2026-000001' });
      expect(blocks.find((block) => block.kind === 'table')).toMatchObject({
        rows: [
          ['1', '02/10/2026 à 09:00:00', 'Notification du mandat', 'Système', 'WhatsApp · lu'],
          [
            '2',
            '05/10/2026 à 15:30:00',
            'Appel sortant',
            'A. Hounsou, chargé de recouvrement',
            'Appel · Promesse de paiement au 30/10',
          ],
        ],
      });
    }
    expect(entry.prepare({ ...base, entries: [second, first] })).toEqual({
      ok: false,
      fields: ['entries.1.at'],
    });
    expect(entry.prepare({ ...base, entries: [{ ...first, delivery: 'perdu' }] }).ok).toBe(false);
    expect(entry.prepare({ ...base, entries: [{ ...first, at: '2026-10-02' }] }).ok).toBe(false);
    expect(entry.prepare({ ...base, entries: [] })).toEqual({ ok: false, fields: ['entries'] });
    // Même horodatage pour deux actions : admis (ordre d'enregistrement conservé).
    expect(entry.prepare({ ...base, entries: [first, { ...second, at: first.at }] }).ok).toBe(true);
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...first,
        at: new Date(Date.UTC(2026, 9, 2) + index * 60_000).toISOString(),
      }));
    expect(MAX_ENTRIES).toBe(1000);
    expect(entry.prepare({ ...base, entries: many(1000) }).ok).toBe(true);
    expect(entry.prepare({ ...base, entries: many(1001) })).toEqual({ ok: false, fields: ['entries'] });
  });

  it('journal de preuve : textes bornés, 1 000 entrées au plus long sous 750 Ko de variables', () => {
    const entry = findTemplate('recovery_evidence_log', 1)!;
    expect(MAX_ENTRIES_BYTES).toBe(750_000);
    const bytesOf = (entries: unknown) => new TextEncoder().encode(JSON.stringify(entries)).length;
    // Textes français au plus long : accents (2 octets) et apostrophes typographiques (3 octets).
    const fill = (length: number) =>
      'Relance écrite à l’adresse connue, réponse attendue. '.repeat(10).slice(0, length);
    const longest = (index: number) => ({
      at: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      action: fill(150),
      actor: fill(100),
      channel: fill(40),
      delivery: 'delivered',
      outcome: fill(250),
    });
    const entries = Array.from({ length: MAX_ENTRIES }, (_, index) => longest(index));
    const variables = {
      caseReference: 'RC-000123',
      creditor: { name: fill(200) },
      debtor: { name: fill(200) },
      openedOn: '2026-01-01',
      currentStage: 'Huissier',
      entries,
    };
    // Le plus long contenu admis en français : 1 000 entrées aux textes complets, sous 750 Ko.
    expect(bytesOf(variables)).toBeLessThan(MAX_ENTRIES_BYTES);
    expect(entry.prepare(variables).ok).toBe(true);
    // Un texte trop long est refusé, champ par champ.
    expect(entry.prepare({ ...variables, entries: [{ ...longest(0), outcome: fill(251) }] })).toEqual({
      ok: false,
      fields: ['entries.0.outcome'],
    });
    expect(entry.prepare({ ...variables, entries: [{ ...longest(0), action: fill(151) }] })).toEqual({
      ok: false,
      fields: ['entries.0.action'],
    });
    // Limite en octets, la première atteinte s'applique : moins de 1 000 entrées mais plus de 750 Ko
    // (caractères de 3 octets) est refusé, quel que soit le nombre de caractères.
    const heavy = entries
      .slice(0, 600)
      .map((item) => ({ ...item, outcome: '’'.repeat(250), action: '’'.repeat(150) }));
    expect(bytesOf(heavy)).toBeGreaterThan(MAX_ENTRIES_BYTES);
    expect(entry.prepare({ ...variables, entries: heavy })).toEqual({ ok: false, fields: ['entries'] });
    // Juste sous la limite en octets : admis.
    const light = heavy.slice(0, 500);
    expect(bytesOf(light)).toBeLessThanOrEqual(MAX_ENTRIES_BYTES);
    expect(entry.prepare({ ...variables, entries: light }).ok).toBe(true);
  });

  it('journal de preuve : partie n/m, numérotation et période contrôlées', () => {
    const entry = findTemplate('recovery_evidence_log', 1)!;
    const base = {
      caseReference: 'RC-000123',
      creditor: { name: 'SARL Bénin Propre' },
      debtor: { name: 'Koffi Mensah' },
      openedOn: '2026-01-01',
      currentStage: 'Huissier',
      part: { index: 2, total: 3, from: '2026-03-01T00:00:00Z', to: '2026-05-31T22:59:59Z' },
      entries: [
        { at: '2026-03-01T00:00:00Z', action: 'Relance', actor: 'Système' },
        { at: '2026-05-31T22:59:59Z', action: 'Appel', actor: 'Système' },
      ],
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.document.title).toBe('Journal des actions du dossier, partie 2/3');
      const text = JSON.stringify(ok.document.build({ ...context, number: 'JDP-2026-000002' }));
      expect(text).toContain('2/3, période du 01/03/2026 à 01:00:00 au 31/05/2026 à 23:59:59');
    }
    expect(entry.prepare({ ...base, part: { ...base.part, index: 4 } })).toEqual({
      ok: false,
      fields: ['part.index'],
    });
    expect(entry.prepare({ ...base, part: { ...base.part, total: 1, index: 1 } }).ok).toBe(false);
    expect(entry.prepare({ ...base, part: { ...base.part, index: 0 } }).ok).toBe(false);
    expect(
      entry.prepare({
        ...base,
        part: { ...base.part, from: '2026-06-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
      }),
    ).toEqual({ ok: false, fields: expect.arrayContaining(['part.to']) as unknown });
    expect(
      entry.prepare({
        ...base,
        entries: [...base.entries, { at: '2026-06-01T00:00:00Z', action: 'Appel', actor: 'Système' }],
      }),
    ).toEqual({ ok: false, fields: ['entries.2.at'] });
    expect(entry.prepare({ ...base, part: { ...base.part, extra: 1 } }).ok).toBe(false);
  });

  it('relevé mensuel : crédité = encaissé − commission − frais, mouvements du mois, totaux', () => {
    const entry = findTemplate('recovery_statement', 1)!;
    expect(entry.info).toMatchObject({ numberPrefix: 'REL', signature: 'none' });
    const movement = {
      date: '2026-11-05',
      label: 'Échéance 1/3',
      collected: 50000,
      commission: 5000,
      costs: 0,
      remitted: 45000,
    };
    const base = {
      caseReference: 'RC-000123',
      creditor: { name: 'SARL Bénin Propre', identification: 'IFU 3201900000000' },
      debtor: { name: 'Koffi Mensah' },
      month: '2026-11',
      movements: [movement, { ...movement, date: '2026-11-20', label: 'Échéance 2/3' }],
      situation: { status: 'Échéancier en cours', collectedToDate: 100000, outstanding: 50000 },
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.document.title).toBe('Relevé du dossier, novembre 2026');
      expect(ok.document.build(context).find((block) => block.kind === 'table')).toMatchObject({
        totalRow: [
          'Total',
          '',
          formatAmount(100000),
          formatAmount(10000),
          formatAmount(0),
          formatAmount(90000),
        ],
      });
    }
    const empty = entry.prepare({ ...base, movements: [] });
    expect(empty.ok && empty.document.build(context).some((block) => block.kind === 'table')).toBe(false);
    expect(entry.prepare({ ...base, movements: [{ ...movement, remitted: 46000 }] })).toEqual({
      ok: false,
      fields: ['movements.0.remitted'],
    });
    expect(entry.prepare({ ...base, movements: [{ ...movement, date: '2026-12-01' }] })).toEqual({
      ok: false,
      fields: ['movements.0.date'],
    });
    expect(entry.prepare({ ...base, month: '2026-13', movements: [] })).toEqual({
      ok: false,
      fields: ['month'],
    });
    expect(entry.prepare({ ...base, situation: { ...base.situation, collectedToDate: 99999 } })).toEqual({
      ok: false,
      fields: ['situation.collectedToDate'],
    });
    const january = entry.prepare({
      ...base,
      month: '2027-01',
      movements: [{ ...movement, date: '2027-01-01' }],
    });
    expect(january.ok && january.document.title).toBe('Relevé du dossier, janvier 2027');
  });

  it('reçu : reste dû, imputation sur les frais, puis les intérêts, puis le principal, trop-perçu', () => {
    const entry = findTemplate('recovery_receipt', 1)!;
    expect(entry.info).toMatchObject({ numberPrefix: 'RCU', signature: 'none' });
    const payment = {
      paidAt: '2026-11-09T22:30:05Z',
      amount: 50000,
      method: 'mobile_money',
      reference: 'FDP-778899',
    };
    const base = {
      caseReference: 'RC-000123',
      creditor: { name: 'SARL Bénin Propre' },
      payer: { name: 'Koffi Mensah' },
      payment,
      dueBefore: 150000,
      dueBreakdown: { costs: 15000, interests: 10000, principal: 125000 },
    };
    const ok = entry.prepare(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const blocks = ok.document.build({ ...context, number: 'RCU-2026-000001' });
      const text = JSON.stringify(blocks);
      expect(text).toContain('09/11/2026 à 23:30:05');
      expect(text).toContain('ne vaut pas quittance');
      expect(blocks.find((block) => block.kind === 'table')).toEqual({
        kind: 'table',
        columns: ['Poste', 'Dû avant', 'Imputé', 'Reste dû'],
        align: ['left', 'right', 'right', 'right'],
        rows: [
          ['Frais de procédure', formatAmount(15000), formatAmount(15000), formatAmount(0)],
          ['Intérêts et pénalités', formatAmount(10000), formatAmount(10000), formatAmount(0)],
          ['Principal', formatAmount(125000), formatAmount(25000), formatAmount(100000)],
        ],
        totalRow: ['Total', formatAmount(150000), formatAmount(50000), formatAmount(100000)],
      });
    }
    // Paiement plus petit que les frais : rien sur les intérêts ni le principal.
    const small = entry.prepare({ ...base, payment: { ...payment, amount: 5000 } });
    expect(small.ok && small.document.build(context).find((block) => block.kind === 'table')).toMatchObject({
      rows: [
        ['Frais de procédure', formatAmount(15000), formatAmount(5000), formatAmount(10000)],
        ['Intérêts et pénalités', formatAmount(10000), formatAmount(0), formatAmount(10000)],
        ['Principal', formatAmount(125000), formatAmount(0), formatAmount(125000)],
      ],
    });
    expect(entry.prepare({ ...base, dueBreakdown: { costs: 0, interests: 0, principal: 140000 } })).toEqual({
      ok: false,
      fields: ['dueBreakdown'],
    });
    expect(entry.prepare({ ...base, allocation: { costs: 0, interests: 0, principal: 50000 } }).ok).toBe(
      false,
    );
    // Sans décomposition : reste dû seulement, pas de tableau d'imputation.
    const plain = entry.prepare({ ...base, dueBreakdown: undefined });
    expect(plain.ok && plain.document.build(context).some((block) => block.kind === 'table')).toBe(false);
    const over = entry.prepare({
      ...base,
      dueBefore: 30000,
      dueBreakdown: { costs: 0, interests: 0, principal: 30000 },
    });
    expect(over.ok).toBe(true);
    if (over.ok) {
      const text = JSON.stringify(over.document.build(context));
      expect(text).toContain('entièrement réglé');
      expect(text).toContain(`dépasse le montant dû de ${formatAmount(20000)}`);
    }
    expect(entry.prepare({ ...base, payment: { ...payment, method: 'cheque' } }).ok).toBe(false);
    expect(entry.prepare({ ...base, payment: { ...payment, amount: 0 } }).ok).toBe(false);
    expect(entry.prepare({ ...base, payment: { ...payment, amount: 1000.5 } }).ok).toBe(false);
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
