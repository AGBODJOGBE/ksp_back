import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Outils communs aux messages du Nettoyage v2 (CDC Nettoyage v2, 16.2). Les variables arrivent
 * déjà mises en forme par les règles (dates, montants, désignation d'une séance) ; `first_name` est
 * ajouté par le service. Aucune variable ne porte d'adresse, de position ni de texte libre (16.3) :
 * seulement des numéros de dossier ou de programme, des dates, des montants, des nombres, des
 * libellés du catalogue et des motifs choisis dans une liste.
 */

export const FIRST_NAME = /^[^\n]{0,100}$/;
export const TEXT = /^[^\n]{1,300}$/;
export const LINK = /^https?:\/\/\S{1,300}$/;
export const COUNT = /^[1-9][0-9]{0,4}$/;
export const INTEGER = /^(0|[1-9][0-9]{0,4})$/;
export const AMOUNT = /^-?[0-9\u00a0]{1,20}\u00a0FCFA$/;
/** Numéro de dossier ou de programme : DN-000124, PN-000057. */
export const NUMBER = /^[A-Z]{1,5}-[0-9]{1,12}$/;

/** Variable dont les valeurs possibles sont fixées par la liste. */
export function oneOf(...values: readonly string[]): RegExp {
  return new RegExp(`^(${values.join('|')})$`);
}

export function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

/** Lignes du message ; les lignes vides (partie facultative absente) sont retirées. */
export function lines(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n');
}

/** « Détails : <lien> », ou rien sans lien (message du personnel sans adresse du back-office). */
export function details(variables: Readonly<Record<string, string>>, label = 'Détails'): string {
  return variables['link'] ? `${label} : ${variables['link']}` : '';
}

/** « 1 séance », « 3 séances ». */
export function plural(count: string, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === '1' ? singular : pluralForm}`;
}

export function template(
  code: string,
  kind: EventTemplateDefinition['kind'],
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
  optionalVariables?: Readonly<Record<string, RegExp>>,
): EventTemplateDefinition {
  return {
    code,
    channels: ['whatsapp', 'email'],
    secret: false,
    kind,
    variables: { first_name: FIRST_NAME, ...variables },
    render,
    ...(optionalVariables ? { optionalVariables } : {}),
  };
}
