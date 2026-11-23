import { z } from 'zod';
import { formatCalendarDate, formatDateTime } from '../format';
import { calendarDate, type DocumentTemplate, line, place, reference } from './template';

/**
 * Journal de preuve, version 1 : extrait horodaté des actions d'un dossier (messages et leur statut
 * de remise, appels, courriers, promesses, paiements, décisions), remis à l'huissier, à l'avocat ou
 * au juge (R-PR-08). Jamais signé : l'empreinte SHA-256 du PDF, gardée par `document`, en garantit
 * l'intégrité. Le service `recovery` choisit les entrées (jamais les notes internes).
 * À faire relire par l'avocat : valeur probante de l'extrait et mentions à y porter.
 */
/**
 * Un export compte au plus `MAX_ENTRIES` entrées et `MAX_ENTRIES_BYTES` octets de variables JSON
 * pour ses entrées : la première limite atteinte s'applique. Au-delà, `recovery` découpe le journal
 * par période, une partie par document (`part`). Le rendu est synchrone et occupe le service
 * `document` tant qu'il dure : environ 1 s pour 1 000 entrées courantes, de 3 à 6 s au pire cas
 * admis (tous les textes au plus long), mesuré sur un poste de développement. Le rendu dans un
 * thread séparé est reporté (risque noté dans ADR-060).
 */
export const MAX_ENTRIES = 1000;
/** Taille maximale des entrées en JSON (octets UTF-8), contrôlée quels que soient les caractères. */
export const MAX_ENTRIES_BYTES = 750_000;

const entry = z.strictObject({
  /** Horodatage UTC ISO 8601, imprimé à l'heure du Bénin. */
  at: z.iso.datetime(),
  action: line(150),
  /** Auteur : nom et rôle (« A. Hounsou, chargé de recouvrement »), ou « Système ». */
  actor: line(100),
  /** Canal : SMS, WhatsApp, e-mail, appel, courrier, visite, en ligne… */
  channel: line(40).optional(),
  /** Statut de remise d'un message. */
  delivery: z.enum(['sent', 'delivered', 'read', 'failed']).optional(),
  /** Résultat ou résumé (« promesse de 50 000 FCFA au 30/11 »). */
  outcome: line(250).optional(),
});

/** Partie d'un journal découpé par période : n° `index` sur `total`, entrées de `from` à `to`. */
const part = z.strictObject({
  index: z.int().min(1).max(1000),
  total: z.int().min(2).max(1000),
  /** Début et fin de la période couverte (UTC ISO 8601, bornes comprises). */
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});

const DELIVERY: Record<NonNullable<z.infer<typeof entry>['delivery']>, string> = {
  sent: 'envoyé',
  delivered: 'remis',
  read: 'lu',
  failed: 'échec de remise',
};

const schema = z
  .strictObject({
    caseReference: reference,
    creditor: z.strictObject({ name: line(200) }),
    debtor: z.strictObject({ name: line(200) }),
    /** Date d'ouverture du dossier. */
    openedOn: calendarDate,
    /** Étape en cours, en clair (« Mise en demeure »). */
    currentStage: line(80),
    /** Destinataire de l'extrait (« Me K. Adjovi, huissier de justice »), facultatif. */
    preparedFor: line(200).optional(),
    /** Partie d'un journal découpé ; absente : le journal tient en un document. */
    part: part.optional(),
    entries: z.array(entry).min(1).max(MAX_ENTRIES),
    place,
  })
  .superRefine((v, ctx) => {
    const from = v.part ? Date.parse(v.part.from) : -Infinity;
    const to = v.part ? Date.parse(v.part.to) : Infinity;
    if (v.part) {
      if (v.part.index > v.part.total) {
        ctx.addIssue({
          code: 'custom',
          path: ['part', 'index'],
          message: 'Numéro de partie au-delà du total.',
        });
      }
      if (from > to) {
        ctx.addIssue({
          code: 'custom',
          path: ['part', 'to'],
          message: 'La période finit avant de commencer.',
        });
      }
    }
    v.entries.forEach((item, index) => {
      const at = Date.parse(item.at);
      const previous = v.entries[index - 1];
      if (previous && at < Date.parse(previous.at)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'at'],
          message: 'Les entrées doivent être dans l’ordre chronologique.',
        });
      }
      if (at < from || at > to) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'at'],
          message: 'L’entrée sort de la période de la partie.',
        });
      }
    });
    if (new TextEncoder().encode(JSON.stringify(v.entries)).length > MAX_ENTRIES_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Journal trop volumineux pour un document : à découper par période.',
      });
    }
  });

export type RecoveryEvidenceLogV1 = z.infer<typeof schema>;

export const recoveryEvidenceLogV1: DocumentTemplate<RecoveryEvidenceLogV1> = {
  code: 'recovery_evidence_log',
  version: 1,
  numberPrefix: 'JDP',
  signature: 'none',
  services: ['recovery'],
  schema,
  title: (v) =>
    v.part
      ? `Journal des actions du dossier, partie ${v.part.index}/${v.part.total}`
      : 'Journal des actions du dossier',
  place: (v) => v.place,
  build: (v, { issuer, timeZone }) => {
    const at = (value: string) => formatDateTime(new Date(value), timeZone);
    const first = v.entries[0]!;
    const last = v.entries[v.entries.length - 1]!;
    const header: [string, string][] = [
      ['Dossier', v.caseReference],
      ['Créancier', v.creditor.name],
      ['Débiteur', v.debtor.name],
      ['Ouvert le', formatCalendarDate(v.openedOn)],
      ['Étape en cours', v.currentStage],
    ];
    if (v.part) {
      header.push([
        'Partie',
        `${v.part.index}/${v.part.total}, période du ${at(v.part.from)} au ${at(v.part.to)}`,
      ]);
    }
    header.push(['Entrées', `${v.entries.length}, du ${at(first.at)} au ${at(last.at)}`]);
    if (v.preparedFor) header.push(['Établi pour', v.preparedFor]);

    const detail = (item: z.infer<typeof entry>) =>
      [item.channel, item.delivery ? DELIVERY[item.delivery] : undefined, item.outcome]
        .filter((part): part is string => Boolean(part))
        .join(' · ') || '—';

    return [
      { kind: 'fields', rows: header },
      {
        kind: 'paragraph',
        text:
          `Extrait du journal des actions tenu par ${issuer.name}, mandataire de ${v.creditor.name}. ` +
          'Chaque entrée est horodatée et attribuée au moment de l’action ; une entrée enregistrée ne ' +
          'peut être ni modifiée ni supprimée. Les heures sont données à l’heure du Bénin.',
      },
      {
        kind: 'table',
        columns: ['N°', 'Date et heure', 'Action', 'Par', 'Canal, remise, résultat'],
        rows: v.entries.map((item, index) => [
          String(index + 1),
          at(item.at),
          item.action,
          item.actor,
          detail(item),
        ]),
      },
      {
        kind: 'paragraph',
        text:
          `L’empreinte numérique (SHA-256) du présent fichier est conservée par ${issuer.name} : elle ` +
          'permet de vérifier, sur demande et avec le numéro du document, que l’extrait n’a pas été modifié.',
      },
    ];
  },
};
