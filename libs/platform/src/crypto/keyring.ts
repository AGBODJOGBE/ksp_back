import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';

/** Identifiant de la clé implicite quand la variable ne contient qu'une clé, sans identifiant. */
export const DEFAULT_KEY_ID = 'default';
/** Identifiant de la clé temporaire tirée hors production quand aucune clé n'est configurée. */
export const EPHEMERAL_KEY_ID = 'ephemeral';

const KEY_ID = /^[a-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;

/** Configuration de clé absente ou invalide : le service refuse de démarrer. */
export class FieldKeyError extends Error {
  override readonly name = 'FieldKeyError';
}

/**
 * Trousseau de clés de 32 octets. La clé active sert à chiffrer (ou à calculer une empreinte) ;
 * toutes servent à relire, ce qui permet la rotation sans tout rechiffrer d'un coup.
 */
export interface FieldKeyring {
  readonly activeId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
  /** Clé tirée au démarrage faute de configuration (hors production) : rien ne survit au redémarrage. */
  readonly ephemeral: boolean;
}

/**
 * Lit un trousseau depuis une variable d'environnement.
 * Formats acceptés :
 * - une clé seule en base64 (32 octets), qui prend l'identifiant `default` ;
 * - une liste `id:clé` séparée par des virgules ; **la première est la clé active**. Pour une rotation,
 *   on ajoute la nouvelle clé en tête et on garde les anciennes derrière tant que des données en dépendent.
 */
export function parseFieldKeyring(raw: string, variable: string): FieldKeyring {
  const value = raw.trim();
  // Les messages d'erreur ne reprennent jamais une entrée illisible : elle peut contenir une clé
  // (identifiant oublié, ordre inversé) et finirait dans les journaux de démarrage. Position seule.
  const entries = value.includes(':')
    ? value.split(',').map((part, index) => {
        const [id, key, ...rest] = part.trim().split(':');
        if (rest.length > 0 || !id || !key) {
          throw new FieldKeyError(`${variable} : entrée n° ${index + 1} illisible (format id:clé attendu).`);
        }
        return [id, key] as const;
      })
    : [[DEFAULT_KEY_ID, value] as const];

  const keys = new Map<string, Buffer>();
  for (const [index, [id, encoded]] of entries.entries()) {
    if (!KEY_ID.test(id)) {
      throw new FieldKeyError(
        `${variable} : identifiant de la clé n° ${index + 1} invalide (a-z, 0-9, _ et -, 32 au plus).`,
      );
    }
    if (id === EPHEMERAL_KEY_ID) {
      throw new FieldKeyError(
        `${variable} : l'identifiant « ${EPHEMERAL_KEY_ID} » est réservé à la clé temporaire.`,
      );
    }
    if (keys.has(id)) throw new FieldKeyError(`${variable} : identifiant de clé « ${id} » en double.`);
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
      throw new FieldKeyError(`${variable} : la clé « ${id} » doit contenir 32 octets en base64.`);
    }
    keys.set(id, key);
  }
  return { activeId: entries[0]![0], keys, ephemeral: false };
}

/**
 * Trousseau d'après la configuration : obligatoire en production ; absent ailleurs, clé temporaire.
 * Avec une clé temporaire, tout ce qui est chiffré (ou indexé) puis enregistré en base devient
 * illisible au redémarrage : un avertissement est journalisé ici, pour qu'aucun service ne l'oublie.
 */
export function fieldKeyringFromConfig(
  raw: string | undefined,
  nodeEnv: string,
  variable: string,
): FieldKeyring {
  const value = raw?.trim();
  if (value) return parseFieldKeyring(value, variable);
  if (nodeEnv === 'production') throw new FieldKeyError(`${variable} est obligatoire en production.`);
  new Logger('FieldKeyring').warn(
    `${variable} absente : clé temporaire tirée au démarrage. Les données chiffrées ou indexées avec elle ` +
      'et enregistrées en base seront illisibles après un redémarrage ; renseigner la clé du .env.example.',
  );
  return {
    activeId: EPHEMERAL_KEY_ID,
    keys: new Map([[EPHEMERAL_KEY_ID, randomBytes(KEY_BYTES)]]),
    ephemeral: true,
  };
}

/**
 * Variable d'environnement d'un trousseau, à placer dans le schéma de configuration du service :
 * facultative hors production, format vérifié dès la lecture de la configuration. Sa présence en
 * production se contrôle dans le `superRefine` du service avec `requireFieldKeysInProduction`.
 */
export function fieldKeyringEnv(variable: string) {
  return z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (!value?.trim()) return;
      try {
        parseFieldKeyring(value, variable);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    });
}

/**
 * Refuse en production, dès la lecture de la configuration, un trousseau absent : le service ne démarre
 * pas, au lieu d'échouer plus tard à la création de son module. À appeler dans le `superRefine` du schéma.
 */
export function requireFieldKeysInProduction(
  cfg: { NODE_ENV: string } & Record<string, unknown>,
  ctx: z.RefinementCtx,
  variables: readonly string[],
): void {
  if (cfg.NODE_ENV !== 'production') return;
  for (const variable of variables) {
    const value = cfg[variable];
    if (typeof value !== 'string' || !value.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: [variable],
        message: `${variable} est obligatoire en production.`,
      });
    }
  }
}

/** Vrai si l'identifiant a la forme d'un identifiant de clé (a-z, 0-9, _ et -, 32 au plus). */
export function isFieldKeyId(id: string): boolean {
  return KEY_ID.test(id);
}

/** Vrai si deux trousseaux lisibles ont une clé en commun (une clé de développement recopiée sous un autre identifiant). */
export function sharesKeyMaterial(a: string, b: string): boolean {
  try {
    const left = [...parseFieldKeyring(a, 'a').keys.values()];
    const right = [...parseFieldKeyring(b, 'b').keys.values()];
    return left.some((key) => right.some((other) => key.equals(other)));
  } catch {
    return false;
  }
}
