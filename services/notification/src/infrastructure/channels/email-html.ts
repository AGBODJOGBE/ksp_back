import { type RenderedMessage } from '../../domain/template';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const URL = /https?:\/\/[^\s<]+/g;

/**
 * Version HTML d'un message en texte brut : chaque ligne devient un paragraphe, les adresses
 * deviennent des liens. Tout le texte est échappé : une variable ne peut pas injecter de balise.
 */
export function toEmailHtml(message: RenderedMessage): string {
  const paragraphs = message.text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${escapeHtml(line).replace(URL, (url) => `<a href="${url}">${url}</a>`)}</p>`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="fr">',
    `<head><meta charset="utf-8"><title>${escapeHtml(message.subject)}</title></head>`,
    '<body style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1f2933;">',
    paragraphs,
    '<p style="color: #6b7280; font-size: 13px;">Groupe KSP — message automatique, merci de ne pas y répondre.</p>',
    '</body>',
    '</html>',
  ].join('\n');
}
