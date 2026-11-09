import { type Block } from '../content';
import { genericV1 } from './generic.v1';
import { recoveryFormalNoticeV1 } from './recovery-formal-notice.v1';
import { recoveryMandateV1 } from './recovery-mandate.v1';
import { recoverySettlementAgreementV1 } from './recovery-settlement-agreement.v1';
import { type DocumentTemplate, type TemplateContext } from './template';

/** Description d'un modèle, sans ses variables. */
export interface TemplateInfo {
  code: string;
  version: number;
  numberPrefix: string;
  signature: DocumentTemplate['signature'];
  services: readonly string[];
}

/** Variables validées d'un modèle, prêtes à être mises en page. */
export interface PreparedDocument {
  template: TemplateInfo;
  title: string;
  place: string;
  build(context: TemplateContext): Block[];
}

export type PrepareResult = { ok: true; document: PreparedDocument } | { ok: false; fields: string[] };

interface CatalogEntry {
  info: TemplateInfo;
  prepare(variables: unknown): PrepareResult;
}

/** Efface le type des variables : chaque entrée valide puis construit avec son propre schéma. */
function entry<V>(template: DocumentTemplate<V>): CatalogEntry {
  const info: TemplateInfo = {
    code: template.code,
    version: template.version,
    numberPrefix: template.numberPrefix,
    signature: template.signature,
    services: template.services,
  };
  return {
    info,
    prepare: (variables) => {
      const parsed = template.schema.safeParse(variables);
      if (!parsed.success) {
        // Chemins seulement (« creditor.name », « installments.2.dueDate ») : jamais les valeurs.
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(racine)'))];
        return { ok: false, fields };
      }
      const value = parsed.data;
      return {
        ok: true,
        document: {
          template: info,
          title: template.title(value),
          place: template.place(value),
          build: (context) => template.build(value, context),
        },
      };
    },
  };
}

/**
 * Catalogue des modèles (ADR-044) : liste fermée, extensible par ajout d'un fichier de version.
 * Une version publiée n'est jamais modifiée ni retirée : les documents produits la citent.
 */
const CATALOG: readonly CatalogEntry[] = [
  entry(recoveryMandateV1),
  entry(recoveryFormalNoticeV1),
  entry(recoverySettlementAgreementV1),
  entry(genericV1),
];

/** Modèle de test, désactivable (production). */
export const TEST_TEMPLATE = 'generic';

/** Version demandée d'un modèle ; 0 : la dernière. null si inconnue. */
export function findTemplate(code: string, version: number): CatalogEntry | null {
  const versions = CATALOG.filter((item) => item.info.code === code);
  if (versions.length === 0) return null;
  if (version === 0) {
    return versions.reduce((latest, item) => (item.info.version > latest.info.version ? item : latest));
  }
  return versions.find((item) => item.info.version === version) ?? null;
}

export function templateCatalog(): TemplateInfo[] {
  return CATALOG.map((item) => item.info);
}

/** Un service peut-il produire ce modèle ? Liste vide : modèle ouvert à tout service. */
export function canProduce(template: TemplateInfo, service: string | null): boolean {
  return service === null || template.services.length === 0 || template.services.includes(service);
}
