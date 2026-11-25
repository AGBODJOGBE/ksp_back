import { type PlanScale } from '../../domain/payment-plan';
import { loadSettings } from '../settings.use-cases';
import { currentCreditor } from '../shared/access';
import { RecoveryErrors } from '../shared/errors';
import { creditorWriter } from './case-access';
import { scaleFrom, UUID } from './case-input';
import { type CaseDeps } from './creditor-cases.use-cases';
import { type CreditorPreferences, type StoredCreditorPreferences } from './ports';

/**
 * Préférences du créancier (14.1, « Préférences ») : barème d'échéancier par défaut de ses nouveaux
 * dossiers, par offre (copié sur chaque dossier créé ensuite), et comptes à prévenir. Sans préférence
 * enregistrée : barèmes de KSP (réglages, partie 6.1).
 */
const MAX_NOTIFIED = 20;

export class GetMyPreferencesUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(): Promise<StoredCreditorPreferences> {
    const creditor = currentCreditor();
    const [{ settings }, stored] = await Promise.all([
      loadSettings(this.deps.settings),
      this.deps.preferences.get(creditor.holder),
    ]);
    return {
      b2bScale: stored?.b2bScale ?? settings.scales.b2b,
      b2cScale: stored?.b2cScale ?? settings.scales.b2c,
      notifyUserIds: stored?.notifyUserIds ?? [],
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }
}

/** Modification des préférences (UpdateMyPreferences) : deux barèmes dans les bornes, 20 comptes au plus. */
export class UpdateMyPreferencesUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: {
    b2bScale: PlanScale | null;
    b2cScale: PlanScale | null;
    notifyUserIds: readonly string[];
  }): Promise<StoredCreditorPreferences> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    if (!input.b2bScale) throw RecoveryErrors.invalid('b2bScale', 'Barème B2B obligatoire.');
    if (!input.b2cScale) throw RecoveryErrors.invalid('b2cScale', 'Barème B2C obligatoire.');
    if (input.notifyUserIds.length > MAX_NOTIFIED) {
      throw RecoveryErrors.invalid('notifyUserIds', `${MAX_NOTIFIED} comptes au plus.`);
    }
    const preferences: CreditorPreferences = {
      b2bScale: scaleFrom('b2bScale', input.b2bScale),
      b2cScale: scaleFrom('b2cScale', input.b2cScale),
      notifyUserIds: [
        ...new Set(
          input.notifyUserIds.map((id, index) => {
            if (!UUID.test(id))
              throw RecoveryErrors.invalid(`notifyUserIds[${index}]`, 'Identifiant invalide.');
            return id.toLowerCase();
          }),
        ),
      ],
    };
    await this.deps.preferences.save(creditor.holder, preferences, creditor.userId, now);
    return { ...preferences, updatedAt: now, updatedBy: creditor.userId };
  }
}
