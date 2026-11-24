import { CLEANING_DIRECT_TEMPLATES } from '../../domain/messages/cleaning-direct.messages';
import { findTemplate, invalidVariables, isEventTemplate } from '../../domain/template';
import { WHATSAPP_EVENT_TEMPLATES } from './whatsapp-templates';

const VARIABLES = {
  link: 'https://agent.ksp.bj/invitations/0192f1c4-0000-7000-8000-0000000000a1',
  expires_on: '30 novembre 2026',
};

describe('message direct du Nettoyage : invitation d’un agent (R-AG-02)', () => {
  it('un seul modèle direct, secret, par WhatsApp puis SMS, jamais un message d’événement', () => {
    expect(CLEANING_DIRECT_TEMPLATES.map((template) => template.code)).toEqual(['cleaning.agent_invitation']);
    const template = findTemplate('cleaning.agent_invitation')!;
    expect(template).toMatchObject({ secret: true, channels: ['whatsapp', 'sms'] });
    expect(isEventTemplate(template)).toBe(false);
  });

  it('variables valides, texte complet avec le lien et la date limite', () => {
    const template = findTemplate('cleaning.agent_invitation')!;
    expect(invalidVariables(template, VARIABLES)).toEqual([]);
    expect(invalidVariables(template, { link: 'ftp://x', expires_on: '' })).toEqual(['link', 'expires_on']);
    const rendered = template.render!(VARIABLES);
    expect(rendered.text).not.toMatch(/undefined|\{\w+\}/);
    expect(rendered.text).toContain('Bonjour Madame, Monsieur,');
    expect(rendered.text).toContain(VARIABLES.link);
    expect(rendered.text).toContain("jusqu'au 30 novembre 2026");
    // Le lien n'est pas dans l'objet : l'objet s'affiche partout.
    expect(rendered.subject).not.toContain('http');
    expect(template.render!({ ...VARIABLES, first_name: 'Awa' }).text).toContain('Bonjour Awa,');
  });

  it('modèle WhatsApp approuvé : nom, puis date limite et lien, jamais de paramètre vide', () => {
    const whatsapp = WHATSAPP_EVENT_TEMPLATES['cleaning.agent_invitation']!;
    expect(whatsapp.name(VARIABLES)).toBe('ksp_cleaning_agent_invitation');
    expect(whatsapp.parameters(VARIABLES)).toEqual(['Madame, Monsieur', '30 novembre 2026', VARIABLES.link]);
    expect(whatsapp.parameters({ ...VARIABLES, first_name: 'Awa' })[0]).toBe('Awa');
  });
});
