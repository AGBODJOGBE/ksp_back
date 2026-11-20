import { asStaff, CatalogMemory } from '../testing/catalog-fakes';
import { CleaningTypesUseCases } from './cleaning-types.use-cases';
import { HolidaysUseCases, SkillsUseCases } from './skills-holidays.use-cases';

function setup() {
  const memory = new CatalogMemory();
  const deps = memory.deps();
  return {
    memory,
    types: new CleaningTypesUseCases(deps),
    skills: new SkillsUseCases(deps),
    holidays: new HolidaysUseCases(deps),
  };
}

async function withSkill() {
  const context = setup();
  await asStaff(() =>
    context.skills.create({
      idempotencyKey: 'cle-skill-001',
      code: 'interieur',
      name: 'Nettoyage intérieur',
    }),
  );
  const sol = await asStaff(() =>
    context.types.create({
      idempotencyKey: 'cle-type-0001',
      code: 'sol',
      name: 'Sol',
      requiredSkillCode: 'interieur',
      referenceDurationMinutes: 180,
      checklist: [{ code: 'sols_laves', label: ' Sols lavés ', order: 0 }],
    }),
  );
  const vitres = await asStaff(() =>
    context.types.create({
      idempotencyKey: 'cle-type-0002',
      code: 'vitres',
      name: 'Vitres',
      requiredSkillCode: 'interieur',
      referenceDurationMinutes: 60,
    }),
  );
  return { ...context, sol, vitres };
}

describe('UC-NT-26 — types de nettoyage (R-CA-09)', () => {
  it('crée un type actif avec sa compétence et sa liste de contrôle, tracé', async () => {
    const { sol, memory } = await withSkill();
    expect(sol).toMatchObject({
      active: true,
      isPack: false,
      requiredSkillCode: 'interieur',
      checklist: [{ code: 'sols_laves', label: 'Sols lavés', order: 0 }],
    });
    expect(memory.audit.map((entry) => entry.action)).toEqual([
      'catalog.skill.created',
      'catalog.cleaning_type.created',
      'catalog.cleaning_type.created',
    ]);
  });

  it('compétence inconnue, absente, code déjà pris', async () => {
    const { types } = await withSkill();
    const base = {
      idempotencyKey: 'cle-type-0003',
      code: 'jardin',
      name: 'Jardin',
      referenceDurationMinutes: 120,
    };
    await expect(
      asStaff(() => types.create({ ...base, requiredSkillCode: 'jardinage' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_SKILL_NOT_FOUND',
      details: { code: 'jardinage' },
    });
    await expect(asStaff(() => types.create(base))).rejects.toMatchObject({
      details: { field: 'requiredSkillCode', reason: 'required' },
    });
    await expect(
      asStaff(() => types.create({ ...base, code: 'sol', requiredSkillCode: 'interieur' })),
    ).rejects.toMatchObject({ code: 'CLEANING_CODE_ALREADY_USED' });
  });

  it('pack de types simples, sans compétence (R-CA-04)', async () => {
    const { types, sol, vitres } = await withSkill();
    const complet = await asStaff(() =>
      types.create({
        idempotencyKey: 'cle-type-0004',
        code: 'complet',
        name: 'Nettoyage complet',
        referenceDurationMinutes: 240,
        isPack: true,
        packItemIds: [sol.id, vitres.id],
      }),
    );
    expect(complet).toMatchObject({
      isPack: true,
      requiredSkillCode: null,
      packItemIds: [sol.id, vitres.id],
    });
  });

  it('un pack ne contient pas de pack ; un type contenu ne devient pas un pack', async () => {
    const { types, sol, vitres } = await withSkill();
    const complet = await asStaff(() =>
      types.create({
        idempotencyKey: 'cle-type-0004',
        code: 'complet',
        name: 'Complet',
        referenceDurationMinutes: 240,
        isPack: true,
        packItemIds: [sol.id],
      }),
    );
    await expect(
      asStaff(() =>
        types.create({
          idempotencyKey: 'cle-type-0005',
          code: 'super',
          name: 'Super',
          referenceDurationMinutes: 240,
          isPack: true,
          packItemIds: [vitres.id, complet.id],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'packItemIds[1]', reason: 'not_applicable' },
    });
    await expect(
      asStaff(() => types.update({ id: sol.id, isPack: true, packItemIds: [vitres.id] })),
    ).rejects.toMatchObject({
      details: { field: 'isPack', reason: 'not_applicable' },
    });
    await expect(
      asStaff(() =>
        types.create({
          idempotencyKey: 'cle-type-0006',
          code: 'menage',
          name: 'Ménage',
          referenceDurationMinutes: 240,
          isPack: true,
          packItemIds: ['inconnu'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_TYPE_NOT_FOUND', details: { cleaningTypeId: 'inconnu' } });
  });

  it('modification : listes remplacées si présentes, désactivation, type redevenu simple', async () => {
    const { types, sol, vitres } = await withSkill();
    const renamed = await asStaff(() => types.update({ id: sol.id, name: 'Sols', active: false }));
    expect(renamed).toMatchObject({ name: 'Sols', active: false, checklist: [{ code: 'sols_laves' }] });
    const complet = await asStaff(() =>
      types.create({
        idempotencyKey: 'cle-type-0004',
        code: 'complet',
        name: 'Complet',
        referenceDurationMinutes: 240,
        isPack: true,
        packItemIds: [sol.id, vitres.id],
      }),
    );
    const simple = await asStaff(() =>
      types.update({ id: complet.id, isPack: false, requiredSkillCode: 'interieur' }),
    );
    expect(simple).toMatchObject({ isPack: false, packItemIds: [] });
    expect((await asStaff(() => types.list({}))).items.map((type) => type.code)).toEqual([
      'complet',
      'sol',
      'vitres',
    ]);
    await expect(asStaff(() => types.get('inconnu'))).rejects.toMatchObject({
      code: 'CLEANING_TYPE_NOT_FOUND',
    });
    await expect(asStaff(() => types.update({ id: 'inconnu' }))).rejects.toMatchObject({
      code: 'CLEANING_TYPE_NOT_FOUND',
    });
  });
});

describe('compétences et jours fériés (R-CA-09, R-PG-02)', () => {
  it('compétence : créée, renommée, désactivée, tracée', async () => {
    const { skills, memory } = setup();
    const skill = await asStaff(() =>
      skills.create({ idempotencyKey: 'cle-skill-001', code: 'vidange', name: 'Vidange' }),
    );
    const updated = await asStaff(() =>
      skills.update({ skillId: skill.id, name: 'Vidange de fosse', active: false }),
    );
    expect(updated).toMatchObject({ code: 'vidange', name: 'Vidange de fosse', active: false });
    expect(memory.audit.at(-1)).toMatchObject({
      action: 'catalog.skill.updated',
      details: { after: { active: false } },
    });
    expect((await asStaff(() => skills.list({}))).total).toBe(1);
    await expect(asStaff(() => skills.update({ skillId: 'inconnue' }))).rejects.toMatchObject({
      code: 'CLEANING_SKILL_NOT_FOUND',
    });
    await expect(
      asStaff(() => skills.create({ idempotencyKey: 'cle-skill-002', code: 'vidange', name: 'V' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_CODE_ALREADY_USED',
    });
  });

  it('jour férié : un par date, retiré puis rajouté, liste par année', async () => {
    const { holidays, memory } = setup();
    const input = { idempotencyKey: 'cle-ferie-001', date: '2026-08-01', name: 'Fête nationale' };
    const holiday = await asStaff(() => holidays.create(input));
    await expect(asStaff(() => holidays.create(input))).resolves.toEqual(holiday);
    await expect(
      asStaff(() => holidays.create({ ...input, idempotencyKey: 'cle-ferie-002' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_CODE_ALREADY_USED',
      details: { code: '2026-08-01' },
    });
    await asStaff(() =>
      holidays.create({ idempotencyKey: 'cle-ferie-003', date: '2027-01-01', name: 'Jour de l’an' }),
    );
    expect((await asStaff(() => holidays.list({}))).items.map((item) => item.date)).toEqual(['2026-08-01']);
    expect((await asStaff(() => holidays.list({ year: 2027 }))).total).toBe(1);
    await asStaff(() => holidays.delete(holiday.id));
    expect((await asStaff(() => holidays.list({}))).total).toBe(0);
    await expect(asStaff(() => holidays.delete(holiday.id))).rejects.toMatchObject({
      code: 'CLEANING_HOLIDAY_NOT_FOUND',
    });
    const again = await asStaff(() => holidays.create({ ...input, idempotencyKey: 'cle-ferie-004' }));
    expect(again.id).toBe(holiday.id);
    expect(memory.audit.map((entry) => entry.action)).toContain('catalog.holiday.deleted');
    await expect(
      asStaff(() => holidays.create({ ...input, idempotencyKey: 'cle-ferie-005', date: '2026-02-30' })),
    ).rejects.toMatchObject({
      details: { field: 'date', reason: 'invalid_type' },
    });
    await expect(asStaff(() => holidays.list({ year: 1999 }))).rejects.toMatchObject({
      details: { field: 'year' },
    });
  });
});
