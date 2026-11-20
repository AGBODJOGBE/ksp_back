import { holidayProblems, skillProblems } from '../../domain/catalog/entries';
import { type CleaningDeps } from '../deps';
import { DuplicateKeyError } from '../ports';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { auditOf } from './audit';
import { type Holiday, type Skill } from './catalog.ports';
import { codeConflict, type PageInput, trim } from './places.use-cases';

/**
 * Compétences d'agent (UC-NT-26, R-CA-09) et jours fériés nationaux (UC-NT-25, R-PG-02), lus par
 * les types de nettoyage et par l'aperçu des dates. Une compétence se désactive ; un jour férié se
 * retire (les séances déjà créées ne changent pas).
 */
export class SkillsUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput): Promise<Page<Skill>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['name']);
    const skills = await this.deps.cleaningTypes.listSkills();
    return pageOf(
      skills.sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      page,
    );
  }

  async create(input: { idempotencyKey: string; code: string; name: string }): Promise<Skill> {
    const userId = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.skill.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: async (response) => this.find(String(response.id)),
      run: async (stub) => {
        const skill: Skill = {
          id: this.deps.ids.next(),
          code: input.code,
          name: trim(input.name) ?? '',
          active: true,
        };
        throwFirstProblem(skillProblems(skill));
        const audit = auditOf({
          actorId: userId,
          action: 'catalog.skill.created',
          entityType: 'skill',
          entityId: skill.id,
          at: now,
          before: null,
          after: { ...skill },
          traced: ['code', 'active'],
        });
        try {
          await this.deps.cleaningTypes.saveSkill(skill, 'create', now, {
            events: [],
            audit: [audit],
            idempotency: stub({ id: skill.id }),
          });
        } catch (error) {
          throw codeConflict(error, skill.code);
        }
        return skill;
      },
    });
  }

  async update(input: {
    skillId: string;
    name?: string | undefined;
    active?: boolean | undefined;
  }): Promise<Skill> {
    const userId = requireStaff();
    const before = await this.find(input.skillId);
    const now = this.deps.clock.now();
    const after: Skill = {
      ...before,
      ...(input.name !== undefined ? { name: trim(input.name) ?? '' } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };
    throwFirstProblem(skillProblems(after));
    const audit = auditOf({
      actorId: userId,
      action: 'catalog.skill.updated',
      entityType: 'skill',
      entityId: after.id,
      at: now,
      before: { ...before },
      after: { ...after },
      traced: ['code', 'active'],
    });
    await this.deps.cleaningTypes.saveSkill(after, 'update', now, { events: [], audit: [audit] });
    return after;
  }

  private async find(id: string): Promise<Skill> {
    const skill = await this.deps.cleaningTypes.getSkill(id);
    if (!skill) throw CleaningErrors.skillNotFound();
    return skill;
  }
}

export class HolidaysUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** Jours fériés d'une année (défaut : l'année en cours), par date. */
  async list(input: PageInput & { year?: number | undefined }): Promise<Page<Holiday>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['date']);
    const year = input.year ?? this.deps.clock.now().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      throw CleaningErrors.validation('year', 'out_of_range');
    return pageOf(await this.deps.holidays.listHolidays(year), page);
  }

  async create(input: { idempotencyKey: string; date: string; name: string }): Promise<Holiday> {
    const userId = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.holiday.create',
      key: idempotencyKey,
      body,
      at: now,
      // Un jour retiré puis rajouté garde sa ligne : le rejeu retrouve le jour par sa date.
      replay: async (response) => {
        const date = String(response.date);
        const holidays = await this.deps.holidays.listHolidays(Number(date.slice(0, 4)));
        return (
          holidays.find((holiday) => holiday.date === date) ?? {
            id: String(response.id),
            date,
            name: trim(input.name) ?? '',
          }
        );
      },
      run: async (stub) => {
        const draft: Holiday = { id: this.deps.ids.next(), date: input.date, name: trim(input.name) ?? '' };
        throwFirstProblem(holidayProblems(draft));
        try {
          return await this.deps.holidays.addHoliday(draft, now, userId, {
            events: [],
            audit: [
              auditOf({
                actorId: userId,
                action: 'catalog.holiday.created',
                entityType: 'holiday',
                entityId: draft.id,
                at: now,
                before: null,
                after: { date: draft.date, name: draft.name },
                traced: ['date'],
              }),
            ],
            idempotency: stub({ id: draft.id, date: draft.date }),
          });
        } catch (error) {
          if (error instanceof DuplicateKeyError && error.key === 'code')
            throw CleaningErrors.codeAlreadyUsed(draft.date);
          throw error;
        }
      },
    });
  }

  async delete(holidayId: string): Promise<void> {
    const userId = requireStaff();
    const holiday = await this.deps.holidays.getHoliday(holidayId);
    if (!holiday) throw CleaningErrors.holidayNotFound();
    const now = this.deps.clock.now();
    await this.deps.holidays.removeHoliday(holiday.id, now, userId, {
      events: [],
      audit: [
        {
          actorId: userId,
          action: 'catalog.holiday.deleted',
          entityType: 'holiday',
          entityId: holiday.id,
          at: now,
          details: { date: holiday.date },
        },
      ],
    });
  }
}
