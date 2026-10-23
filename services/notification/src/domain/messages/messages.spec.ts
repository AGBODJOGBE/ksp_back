import { eventChannelPlan } from '../channel';
import { EmailAddress } from '../recipient';
import { findTemplate, invalidVariables, isEventTemplate } from '../template';
import { CLEANING_TEMPLATES, paymentNote } from './cleaning.messages';
import { formatDate, formatDateTime, formatDuration, formatXof } from './format';

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
