/**
 * Catalogue des permissions du Nettoyage (cahier des charges v2, partie 2, R-RB-01 ; ADR-057) :
 * la seule liste des permissions du service et de ses rôles livrés par défaut, déclarée à identity
 * à chaque démarrage (RegisterCatalog). Une permission ne se crée pas à la main : chacune correspond
 * à un contrôle réel, à la gateway (permission de la route) ou dans le service.
 *
 * Règles d'identity à connaître avant de modifier ce fichier :
 * - le catalogue reçu remplace celui du service : une permission retirée d'ici est marquée
 *   « retirée » et n'entre plus dans les jetons ;
 * - une version déjà enregistrée est sans effet : toute modification augmente `version` ;
 * - un rôle absent est créé, un rôle existant n'est jamais écrasé (le super administrateur a pu le
 *   modifier, R-RB-02). Les cinq rôles ci-dessous existent déjà dans identity, sans permission
 *   cochée : leur déclaration ne vaut donc que pour une base où ils manquent. Ailleurs, le super
 *   administrateur coche leurs permissions au back-office ;
 * - un service ne déclare que ses propres permissions : `finance_officer` et `support_agent`, qui
 *   servent plusieurs métiers, ne reçoivent ici que leurs permissions du Nettoyage.
 */

export interface CatalogPermission {
  /** `cleaning.<module>.<action>`. */
  code: string;
  /** Ce qu'elle permet, affiché à côté de la case à cocher du back-office. */
  description: string;
}

export interface CatalogRole {
  code: string;
  /** Nom affiché au back-office. */
  name: string;
  description: string;
  /** Portée d'une attribution : tout l'écosystème, ou le métier. */
  scopeType: 'global' | 'domain';
  requiresMfa: boolean;
  backofficeAccess: boolean;
  /** Son retrait ferme tout de suite les sessions de la personne (R-RB-05). */
  sensitive: boolean;
  permissions: readonly string[];
}

export interface PermissionCatalog {
  service: 'cleaning';
  version: number;
  permissions: readonly CatalogPermission[];
  roles: readonly CatalogRole[];
}

/** Permissions du tableau « Permissions du module Nettoyage », dans son ordre. */
const PERMISSIONS: readonly CatalogPermission[] = [
  {
    code: 'cleaning.catalog.read',
    description: 'Lire les lieux, types, paramètres, tarifs, packs et listes de contrôle',
  },
  {
    code: 'cleaning.catalog.manage',
    description: 'Gérer les lieux, types, paramètres, tarifs, packs et listes de contrôle',
  },
  { code: 'cleaning.zone.manage', description: 'Gérer les zones desservies' },
  { code: 'cleaning.request.read', description: 'Lire les demandes' },
  {
    code: 'cleaning.request.process',
    description: 'Traiter les demandes (refuser, planifier une visite)',
  },
  { code: 'cleaning.visit.perform', description: 'Réaliser une visite et saisir le constat' },
  { code: 'cleaning.quote.manage', description: 'Ajuster le constat, composer et envoyer un devis' },
  {
    code: 'cleaning.quote.adjust_price',
    description: 'Ajouter une remise ou une majoration manuelle (motif obligatoire)',
  },
  { code: 'cleaning.program.read', description: 'Lire les programmes' },
  {
    code: 'cleaning.program.manage',
    description: 'Gérer les programmes (annuler, suspendre, reprendre)',
  },
  {
    code: 'cleaning.planning.manage',
    description: 'Affecter et désaffecter les agents, lancer la planification automatique',
  },
  { code: 'cleaning.session.perform', description: 'Réaliser une séance (agent)' },
  {
    code: 'cleaning.agent.manage',
    description: 'Valider les candidatures, gérer les profils, compétences et zones des agents',
  },
  { code: 'cleaning.amounts.read', description: 'Voir les montants (refusé par défaut aux agents)' },
  { code: 'cleaning.settings.manage', description: 'Modifier les réglages du module' },
  { code: 'cleaning.claim.manage', description: 'Traiter les réclamations' },
];

/**
 * Permissions qu'aucune route n'exige, et pourquoi elles sont déclarées quand même : le service les
 * contrôle lui-même.
 */
export const PERMISSIONS_WITHOUT_ROUTE: Readonly<Record<string, string>> = {
  'cleaning.amounts.read':
    'Décide si les montants figurent dans les réponses du back-office (R-EX-04, partie 16.3).',
};

/** Permissions de terrain : livrées au seul agent (R-AG-01, reprise RV-07). */
const FIELD_PERMISSIONS = ['cleaning.visit.perform', 'cleaning.session.perform'];

/** Rôle du back-office : double authentification exigée. */
function staff(
  code: string,
  name: string,
  description: string,
  scopeType: CatalogRole['scopeType'],
  permissions: readonly string[],
  sensitive = false,
): CatalogRole {
  return {
    code,
    name,
    description,
    scopeType,
    requiresMfa: true,
    backofficeAccess: true,
    sensitive,
    permissions,
  };
}

/**
 * Rôles livrés par défaut (partie 2), avec les permissions que le contrat leur donne
 * (`x-ksp-default-roles` de chaque route). `super_admin` n'y figure pas : identity lui donne toutes
 * les permissions du catalogue.
 */
const ROLES: readonly CatalogRole[] = [
  staff(
    'cleaning_admin',
    'Administrateur Nettoyage',
    'Responsable du métier Nettoyage : tout le module, hors actions de terrain',
    'domain',
    PERMISSIONS.map((permission) => permission.code).filter((code) => !FIELD_PERMISSIONS.includes(code)),
  ),
  staff(
    'cleaning_supervisor',
    'Superviseur Nettoyage',
    'Demandes, visites, devis, programmes, planning, réclamations, lecture du catalogue',
    'domain',
    [
      'cleaning.catalog.read',
      'cleaning.request.read',
      'cleaning.request.process',
      'cleaning.quote.manage',
      'cleaning.program.read',
      'cleaning.program.manage',
      'cleaning.planning.manage',
      'cleaning.claim.manage',
    ],
  ),
  {
    // Agent de terrain : application agent, code par SMS et appareil enregistré (R-RB-07), ni
    // back-office ni application d'authentification. Attribué par cleaning à la validation (R-AG-01).
    code: 'cleaning_agent',
    name: 'Agent de nettoyage',
    description: 'Agent de terrain du Nettoyage : visites et séances qui lui sont affectées',
    scopeType: 'domain',
    requiresMfa: false,
    backofficeAccess: false,
    sensitive: false,
    permissions: FIELD_PERMISSIONS,
  },
  staff(
    'finance_officer',
    'Finance',
    'Finance : montants, factures, recharges, remboursements',
    'domain',
    ['cleaning.amounts.read'],
    true,
  ),
  staff('support_agent', 'Support', 'Support client : consultation des dossiers, réclamations', 'global', [
    'cleaning.catalog.read',
    'cleaning.request.read',
    'cleaning.program.read',
    'cleaning.claim.manage',
  ]),
];

export const CLEANING_PERMISSION_CATALOG: PermissionCatalog = {
  service: 'cleaning',
  version: 1,
  permissions: PERMISSIONS,
  roles: ROLES,
};
