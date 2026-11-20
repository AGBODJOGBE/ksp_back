import { type ChoiceEntry, parameterNarrowing, parameterProblems } from '../../domain/catalog/entries';
import { type ParameterKind } from '../../domain/pricing/types';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { auditOf } from './audit';
import { type Parameter } from './catalog.ports';
import { codeConflict, type PageInput, trim } from './places.use-cases';

/**
 * UC-NT-27 — Gérer les paramètres (R-CA-01, R-CA-02, R-CA-06, R-CA-11). La nature ne se modifie
 * pas ; une valeur de choix se désactive au lieu d'être retirée. Un paramètre utilisé par un tarif
 * publié ou un lieu actif ne peut être ni resserré, ni privé d'une valeur, ni désactivé
 * (CLEANING_PARAMETER_IN_USE).
 */
const KINDS: readonly ParameterKind[] = ['number', 'choice', 'boolean'];
const TRACED = ['code', 'kind', 'unit', 'min', 'max', 'required', 'active', 'choiceCodes'];

export interface ParameterFields {
  label?: string | undefined;
  unit?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  /** Absent : inchangé (modification) ; présent : remplace la liste. */
  choices?: ChoiceEntry[] | undefined;
  required?: boolean | undefined;
  help?: string | undefined;
}

const snapshot = (parameter: Parameter) => ({
  code: parameter.code,
  label: parameter.label,
  kind: parameter.kind,
  unit: parameter.unit,
  min: parameter.min,
  max: parameter.max,
  required: parameter.required,
  help: parameter.help,
  active: parameter.active,
  choiceCodes: parameter.choices.map((choice) => `${choice.code}${choice.active ? '' : ' (inactive)'}`),
  choiceLabels: parameter.choices.map((choice) => choice.label),
});

const cleanChoices = (choices: ChoiceEntry[]) =>
  choices.map((choice) => ({ code: choice.code, label: trim(choice.label) ?? '', active: choice.active }));

export class ParametersUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput): Promise<Page<Parameter>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['code']);
    const parameters = await this.deps.parameters.listParameters();
    return pageOf(
      parameters.sort((a, b) => (a.code < b.code ? -1 : 1)),
      page,
    );
  }

  async get(id: string): Promise<Parameter> {
    requireStaff();
    const parameter = await this.deps.parameters.getParameter(id);
    if (!parameter) throw CleaningErrors.parameterNotFound();
    return parameter;
  }

  async create(
    input: ParameterFields & { idempotencyKey: string; code: string; kind: string; label: string },
  ): Promise<Parameter> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.parameter.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.get(String(response.id)),
      run: async (stub) => {
        if (!KINDS.includes(input.kind as ParameterKind))
          throw CleaningErrors.validation('kind', 'invalid_type');
        const parameter: Parameter = {
          id: this.deps.ids.next(),
          code: input.code,
          label: trim(input.label) ?? '',
          kind: input.kind as ParameterKind,
          unit: trim(input.unit),
          min: input.min ?? null,
          max: input.max ?? null,
          choices: cleanChoices(input.choices ?? []),
          required: input.required ?? false,
          help: trim(input.help),
          active: true,
          updatedAt: now,
          updatedBy: userId,
        };
        throwFirstProblem(parameterProblems(parameter));
        const audit = auditOf({
          actorId: userId,
          action: 'catalog.parameter.created',
          entityType: 'parameter',
          entityId: parameter.id,
          at: now,
          before: null,
          after: snapshot(parameter),
          traced: TRACED,
        });
        try {
          await this.deps.parameters.saveParameter(parameter, 'create', {
            events: [],
            audit: [audit],
            idempotency: stub({ id: parameter.id }),
          });
        } catch (error) {
          throw codeConflict(error, parameter.code);
        }
        return parameter;
      },
    });
  }

  async update(input: ParameterFields & { id: string; active?: boolean | undefined }): Promise<Parameter> {
    const { userId } = requireStaff();
    const before = await this.deps.parameters.getParameter(input.id);
    if (!before) throw CleaningErrors.parameterNotFound();
    const now = this.deps.clock.now();
    const after: Parameter = {
      ...before,
      ...(input.label !== undefined ? { label: trim(input.label) ?? '' } : {}),
      ...(input.unit !== undefined ? { unit: trim(input.unit) } : {}),
      ...(input.min !== undefined ? { min: input.min } : {}),
      ...(input.max !== undefined ? { max: input.max } : {}),
      ...(input.choices !== undefined ? { choices: cleanChoices(input.choices) } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
      ...(input.help !== undefined ? { help: trim(input.help) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: now,
      updatedBy: userId,
    };
    throwFirstProblem(parameterProblems(after));
    if (parameterNarrowing(before, after).length) {
      const usage = await this.deps.parameters.usageOf(before.id);
      if (usage.offerIds.length || usage.placeTypeIds.length) {
        throw CleaningErrors.parameterInUse(usage.offerIds, usage.placeTypeIds);
      }
    }
    const audit = auditOf({
      actorId: userId,
      action: 'catalog.parameter.updated',
      entityType: 'parameter',
      entityId: after.id,
      at: now,
      before: snapshot(before),
      after: snapshot(after),
      traced: TRACED,
    });
    await this.deps.parameters.saveParameter(after, 'update', { events: [], audit: [audit] });
    return after;
  }
}
