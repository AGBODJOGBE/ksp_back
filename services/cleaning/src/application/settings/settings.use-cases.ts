import { hasPermission, requirePermission } from '@ksp/platform';
import { mergeSettings, type ModuleSettings, settingsChanges } from '../../domain/settings/settings';
import { type CleaningDeps } from '../deps';
import { type Changes } from '../ports';
import { requireStaff } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { writeError } from '../shared/idempotency';

/**
 * Réglages du module (UC-NT-43, partie 16.1) : lecture pour tout le personnel du module, modification
 * par l'admin Nettoyage, bornée, validée en entier après fusion (RV-29) et tracée au journal
 * d'audit (settings.updated, avant et après).
 */

/** Lecture : tout le personnel du module (contrat GetSettings). */
export const SETTINGS_READ_PERMISSION = 'cleaning.request.read';
/** Modification (contrat UpdateSettings). */
export const SETTINGS_MANAGE_PERMISSION = 'cleaning.settings.manage';
/** Montants visibles (frais de visite par défaut). */
export const AMOUNTS_READ_PERMISSION = 'cleaning.amounts.read';

/**
 * Noms du contrat (API REST et gRPC) des réglages dont le nom diffère de celui de la base ; les
 * autres portent le même nom. Sert aux messages et à details.field (RV-29).
 */
export const CONTRACT_FIELD_NAMES: Readonly<Partial<Record<keyof ModuleSettings, string>>> = {
  maxOpenRequests: 'maxOpenRequestsPerAccount',
  visitTargetHours: 'visitTargetBusinessHours',
  maxDiscountWithoutApprovalPct: 'maxDiscountWithoutApprovalPercent',
  maxReschedulesPerMonth: 'reschedulesPerMonth',
  lateCancellationFeePct: 'lateCancellationFeePercent',
  defaultMaxHoursDay: 'defaultMaxHoursPerDay',
  defaultMaxHoursWeek: 'defaultMaxHoursPerWeek',
  maxPhotosPerType: 'maxPhotosPerKind',
};

/** Champ du contrat d'un problème du domaine (« scoreWeights.continuity » gardé tel quel). */
export function contractField(field: string): string {
  const [head, ...rest] = field.split(/(?=[.[])/);
  const renamed = CONTRACT_FIELD_NAMES[head as keyof ModuleSettings] ?? head;
  return [renamed, ...rest].join('');
}

export interface StoredSettings {
  settings: ModuleSettings;
  updatedAt: Date | null;
  updatedBy: string | null;
  version: number;
}

export interface SettingsRepository {
  read(): Promise<StoredSettings>;
  /** Refuse (ConcurrentUpdateError) si la version a changé ; écrit les changements dans la même transaction. */
  save(
    settings: ModuleSettings,
    expected: { version: number; by: string; at: Date },
    changes: Changes,
  ): Promise<void>;
}

export interface SettingsView extends StoredSettings {
  updatedByName: string | null;
  /** Faux pour qui n'a pas le droit de voir les montants : les frais de visite ne sont pas rendus. */
  showAmounts: boolean;
}

export class SettingsUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async get(): Promise<SettingsView> {
    requireStaff();
    const user = requirePermission(SETTINGS_READ_PERMISSION);
    return this.view(await this.deps.moduleSettings.read(), hasPermission(user, AMOUNTS_READ_PERMISSION));
  }

  async update(patch: Partial<ModuleSettings>): Promise<SettingsView> {
    const actorId = requireStaff();
    const user = requirePermission(SETTINGS_MANAGE_PERMISSION);
    const current = await this.deps.moduleSettings.read();
    const merged = mergeSettings(current.settings, patch);
    if (!merged.ok) {
      const [first] = merged.problems;
      throw cleaningErrors.invalid(contractField(first!.field), first!.reason);
    }
    const now = this.deps.clock.now();
    const { before, after } = settingsChanges(current.settings, merged.value);
    if (Object.keys(after).length) {
      await this.deps.moduleSettings
        .save(
          merged.value,
          { version: current.version, by: actorId, at: now },
          {
            events: [],
            audit: [
              {
                actorId,
                action: 'settings.updated',
                entityType: 'settings',
                entityId: 'cleaning',
                at: now,
                details: { before, after },
              },
            ],
          },
        )
        .catch((error: unknown) => {
          throw writeError(error);
        });
    }
    return this.view(await this.deps.moduleSettings.read(), hasPermission(user, AMOUNTS_READ_PERMISSION));
  }

  private async view(stored: StoredSettings, showAmounts: boolean): Promise<SettingsView> {
    const names = stored.updatedBy ? await this.deps.people.userNames([stored.updatedBy]) : new Map();
    return {
      ...stored,
      updatedByName: stored.updatedBy ? (names.get(stored.updatedBy) ?? null) : null,
      showAmounts,
    };
  }
}
