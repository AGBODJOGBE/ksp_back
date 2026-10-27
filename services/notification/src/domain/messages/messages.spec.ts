import { eventChannelPlan, eventDispatchPlans } from '../channel';
import { EmailAddress } from '../recipient';
import { findTemplate, invalidVariables, isEventTemplate } from '../template';
import { BILLING_TEMPLATES } from './billing.messages';
import { CLEANING_TEMPLATES, paymentNote, unpaidText } from './cleaning.messages';
import { formatDate, formatDateTime, formatDuration, formatXof } from './format';
import { ORGANIZATION_TEMPLATES } from './organization.messages';

const NBSP = '\u00a0';

describe('Mise en forme', () => {
  it('montants en FCFA entiers, milliers séparés par une espace insécable', () => {
    expect(formatXof(0)).toBe(`0${NBSP}FCFA`);
    expect(formatXof(3500)).toBe(`3${NBSP}500${NBSP}FCFA`);
    expect(formatXof(1250000)).toBe(`1${NBSP}250${NBSP}000${NBSP}FCFA`);
  });

  it('dates à l’heure du Bénin (UTC+1)', () => {
    expect(formatDateTime('2026-10-29T23:30:00Z')).toBe('vendredi 30 octobre 2026 à 00:30');
    expect(formatDate('2026-11-15T22:59:59Z')).toBe('15 novembre 2026');
    expect(formatDateTime('pas une date')).toBeNull();
  });

  it('durées', () => {
    expect(formatDuration(45)).toBe(`45${NBSP}min`);
    expect(formatDuration(120)).toBe(`2${NBSP}h`);
    expect(formatDuration(65)).toBe(`1${NBSP}h${NBSP}05`);
  });
});

describe('Règle de choix du canal des messages d’événements', () => {
  it('message court : WhatsApp puis e-mail', () => {
    expect(eventChannelPlan('short', { hasPhone: true, hasEmail: true })).toEqual(['whatsapp', 'email']);
    expect(eventChannelPlan('short', { hasPhone: false, hasEmail: true })).toEqual(['email']);
  });

  it('document : e-mail puis WhatsApp', () => {
    expect(eventChannelPlan('document', { hasPhone: true, hasEmail: true })).toEqual(['email', 'whatsapp']);
    expect(eventChannelPlan('document', { hasPhone: true, hasEmail: false })).toEqual(['whatsapp']);
    expect(eventChannelPlan('document', { hasPhone: false, hasEmail: false })).toEqual([]);
  });
});

describe('Envois d’un message d’événement', () => {
  it('court ou document : un seul envoi, avec bascule', () => {
    expect(eventDispatchPlans('short', { hasPhone: true, hasEmail: true })).toEqual([['whatsapp', 'email']]);
    expect(eventDispatchPlans('document', { hasPhone: false, hasEmail: false })).toEqual([]);
  });

  it('important : un envoi par WhatsApp et un par e-mail, sans bascule', () => {
    expect(eventDispatchPlans('important', { hasPhone: true, hasEmail: true })).toEqual([
      ['whatsapp'],
      ['email'],
    ]);
    expect(eventDispatchPlans('important', { hasPhone: false, hasEmail: true })).toEqual([['email']]);
    expect(eventDispatchPlans('important', { hasPhone: false, hasEmail: false })).toEqual([]);
  });
});

describe('Impayés', () => {
  it('factures d’entreprise ou passages d’un particulier, au singulier ou au pluriel', () => {
    expect(unpaidText('unpaid_invoices', 1)).toBe('1 facture impayée');
    expect(unpaidText('unpaid_invoices', 3)).toBe('3 factures impayées');
    expect(unpaidText('unpaid_interventions', 2)).toBe('2 passages impayés');
  });
});

describe('EmailAddress', () => {
  it('normalise et masque l’adresse', () => {
    const address = EmailAddress.parse('  Koffi.Adjovi@Example.COM ');
    expect(address?.value).toBe('koffi.adjovi@example.com');
    expect(address?.masked()).toBe('k***@example.com');
  });

  it.each([null, '', 'koffi', 'koffi@', '@example.com', 'koffi@example', 'a b@example.com'])(
    'refuse %p',
    (value) => expect(EmailAddress.parse(value)).toBeNull(),
  );
});

describe('Modèles du Nettoyage', () => {
  it('sont tous au catalogue, réservés aux événements, par WhatsApp et e-mail', () => {
    for (const template of CLEANING_TEMPLATES) {
      const found = findTemplate(template.code);
      expect(found).toBe(template);
      expect(isEventTemplate(found!)).toBe(true);
      expect(template.channels).toEqual(['whatsapp', 'email']);
      expect(template.code).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
    expect(isEventTemplate(findTemplate('identity.otp')!)).toBe(false);
    expect(isEventTemplate(findTemplate('identity.email_verification')!)).toBe(false);
  });

  it('salutation sans prénom', () => {
    const template = findTemplate('cleaning.visit_scheduled.agent');
    expect(isEventTemplate(template!) && template.render({ first_name: '', date: 'demain' }).text).toMatch(
      /^Bonjour,\n/,
    );
  });

  it('un lien qui n’est pas une adresse web est refusé', () => {
    const template = findTemplate('cleaning.quote_requested.customer')!;
    expect(
      invalidVariables(template, { first_name: '', visit_required: 'false', link: 'javascript:alert(1)' }),
    ).toEqual(['link']);
  });

  it('phrase du paiement choisi', () => {
    expect(
      paymentNote({ option: 'full', timing: 'after', method: 'cash', total: 20000, deposit: 6000 }),
    ).toBe(`Paiement choisi : totalité (20${NBSP}000${NBSP}FCFA), après l'intervention, en espèces.`);
  });
});

describe('Code de confirmation de l’e-mail (identity.email_verification)', () => {
  const template = findTemplate('identity.email_verification')!;

  it('modèle secret, par e-mail seulement, avec son propre texte', () => {
    expect(template).toMatchObject({ secret: true, channels: ['email'] });
    expect(invalidVariables(template, { code: '482913', expires_in_minutes: '15' })).toEqual([]);
    expect(invalidVariables(template, { code: '48 29', expires_in_minutes: '0' })).toEqual([
      'code',
      'expires_in_minutes',
    ]);
  });

  it('donne le code et sa durée, sans le code dans l’objet', () => {
    const message = template.render!({ code: '482913', expires_in_minutes: '1' });
    expect(message.subject).toBe('Confirmez votre adresse e-mail KSP');
    expect(message.text).toContain('482913');
    expect(message.text).toContain('valable 1 minute.');
    expect(message.text.startsWith('Bonjour,\n')).toBe(true);
  });
});

describe('Modèles de la facturation', () => {
  const issued = {
    first_name: 'Koffi',
    invoice_number: 'FAC-2026-000042',
    period: 'du 1 novembre 2026 au 30 novembre 2026',
    total: `150${NBSP}000${NBSP}FCFA`,
    due_on: '11 décembre 2026',
    link: 'https://ksp.bj/mon-espace/factures/i-1',
  };

  it('sont tous au catalogue, documents, par WhatsApp et e-mail', () => {
    expect(BILLING_TEMPLATES.map((template) => template.code)).toEqual([
      'billing.invoice_issued.customer',
      'billing.invoice_overdue.customer',
      'billing.invoice_paid.customer',
    ]);
    for (const template of BILLING_TEMPLATES) {
      expect(findTemplate(template.code)).toBe(template);
      expect(template).toMatchObject({ kind: 'document', secret: false, channels: ['whatsapp', 'email'] });
    }
  });

  it('facture émise : numéro, période, montant en FCFA entiers, échéance et lien', () => {
    const template = findTemplate('billing.invoice_issued.customer')!;
    expect(invalidVariables(template, issued)).toEqual([]);
    const message = template.render!(issued);
    expect(message.subject).toBe('Votre facture FAC-2026-000042');
    expect(message.text).toBe(
      [
        'Bonjour Koffi,',
        'Votre facture FAC-2026-000042 est disponible : période du 1 novembre 2026 au 30 novembre 2026, ' +
          `montant 150${NBSP}000${NBSP}FCFA.`,
        'Elle est à régler avant le 11 décembre 2026, en espèces, par virement ou par Mobile Money ' +
          "auprès de l'équipe KSP.",
        'Consultez-la dans Mon espace KSP, rubrique « Mes factures » : https://ksp.bj/mon-espace/factures/i-1',
      ].join('\n'),
    );
  });

  it('numéro de facture ou montant mal formés : refusés', () => {
    const template = findTemplate('billing.invoice_issued.customer')!;
    expect(
      invalidVariables(template, { ...issued, invoice_number: 'FAC-42', total: '1500.50 FCFA' }),
    ).toEqual(['invoice_number', 'total']);
  });

  it('facture impayée : désigne la facture, sans reprendre l’avertissement du Nettoyage', () => {
    const template = findTemplate('billing.invoice_overdue.customer')!;
    const { period: _period, ...variables } = issued;
    const message = template.render!({ ...variables, first_name: '' });
    expect(message.subject).toBe('Facture FAC-2026-000042 impayée');
    expect(message.text.startsWith('Bonjour,\n')).toBe(true);
    expect(message.text).toContain(
      `Votre facture FAC-2026-000042 de 150${NBSP}000${NBSP}FCFA, à régler avant le 11 décembre 2026, ` +
        "n'est pas entièrement réglée",
    );
    expect(message.text).not.toContain('suspen');
  });

  it.each([
    ['0', null],
    ['1', 'Il reste 1 facture impayée sur ce contrat.'],
    ['2', 'Il reste 2 factures impayées sur ce contrat.'],
  ])('facture réglée, %s impayée(s) restante(s)', (unpaidLeft, expected) => {
    const template = findTemplate('billing.invoice_paid.customer')!;
    const variables = {
      first_name: 'Koffi',
      invoice_number: 'FAC-2026-000042',
      total: `150${NBSP}000${NBSP}FCFA`,
      paid_on: '16 décembre 2026',
      unpaid_left: unpaidLeft,
      link: 'https://ksp.bj/mon-espace/factures/i-1',
    };
    expect(invalidVariables(template, variables)).toEqual([]);
    const message = template.render!(variables);
    expect(message.subject).toBe('Facture FAC-2026-000042 réglée');
    expect(message.text).toContain('est réglée en totalité depuis le 16 décembre 2026.');
    if (expected) expect(message.text).toContain(expected);
    else expect(message.text).not.toContain('Il reste');
  });
});

describe('Comptes entreprise (ADR-027)', () => {
  it('modèles des événements : au catalogue, par WhatsApp et e-mail, messages courts', () => {
    for (const template of ORGANIZATION_TEMPLATES) {
      expect(findTemplate(template.code)).toBe(template);
      expect(template).toMatchObject({ channels: ['whatsapp', 'email'], kind: 'short', secret: false });
    }
  });

  it('code de l’e-mail de facturation : modèle secret, par e-mail, qui cite l’entreprise', () => {
    const template = findTemplate('identity.organization_email_verification')!;
    expect(template).toMatchObject({ secret: true, channels: ['email'] });
    expect(isEventTemplate(template)).toBe(false);
    const variables = { code: '482913', expires_in_minutes: '15', organization_name: 'SARL Bénin Propre' };
    expect(invalidVariables(template, variables)).toEqual([]);
    expect(invalidVariables(template, { code: '482913', expires_in_minutes: '15' })).toEqual([
      'organization_name',
    ]);
    const message = template.render!(variables);
    expect(message.subject).not.toContain('482913');
    expect(message.text).toContain('adresse de facturation de SARL Bénin Propre');
    expect(message.text).toContain('482913');
  });
});
