import { activeCase, asAgent, asSupervisor } from '../testing/amicable-scenarios';
import { rejection } from '../testing/fakes';
import {
  activePartner,
  asLegal,
  BAILIFF_USER_ID,
  litigationWorld,
  OTHER_BAILIFF_USER_ID,
  partnerInput,
  VERIFICATION_FILE,
  VERIFICATION_FILE_2,
} from '../testing/litigation-scenarios';

describe('référentiel des partenaires (UC-RC-24, R-HU-01)', () => {
  it('crée une fiche en attente de vérification, coordonnées normalisées, rejouable', async () => {
    const world = litigationWorld();
    const created = await asLegal(world, () =>
      world.useCases.createPartner.execute({ idempotencyKey: 'partner-0001', input: partnerInput() }),
    );
    expect(created.partner).toMatchObject({
      kind: 'bailiff',
      name: 'Me Adjovi',
      status: 'pending_verification',
      areas: ['cotonou'],
      phones: ['+2290197000555'],
      email: 'etude@adjovi.bj',
      userId: BAILIFF_USER_ID,
      verifiedBy: null,
    });
    expect(created.stats).toEqual({
      openAssignments: 0,
      closedAssignments: 0,
      successfulAssignments: 0,
      averageDays: null,
    });
    expect(world.files.subjects.get(VERIFICATION_FILE)).toEqual({
      type: 'recovery_partner',
      id: created.partner.id,
    });
    expect(world.litigation.partnerAudit).toEqual([
      expect.objectContaining({ action: 'partner.created', details: { kind: 'bailiff' } }),
    ]);
    const again = await asLegal(world, () =>
      world.useCases.createPartner.execute({ idempotencyKey: 'partner-0001', input: partnerInput() }),
    );
    expect(again.partner.id).toBe(created.partner.id);
    // Un compte partenaire ne sert qu'à une fiche.
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.createPartner.execute({
            idempotencyKey: 'partner-0002',
            input: partnerInput({ verificationFileId: VERIFICATION_FILE_2 }),
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'input.userId' } });
  });

  it('refuse une saisie invalide et les rôles hors du juriste', async () => {
    const world = litigationWorld();
    const create = (change: Parameters<typeof partnerInput>[0]) =>
      rejection(
        asLegal(world, () =>
          world.useCases.createPartner.execute({
            idempotencyKey: 'partner-0001',
            input: partnerInput(change),
          }),
        ),
      );
    expect(await create({ kind: 'notary' })).toMatchObject({ details: { field: 'input.kind' } });
    expect(await create({ communeKeys: [] })).toMatchObject({ details: { field: 'input.communeKeys' } });
    expect(await create({ phones: ['123'] })).toMatchObject({ details: { field: 'input.phones' } });
    expect(await create({ fees: [{ actType: 'lunch', amount: 10 }] })).toMatchObject({
      details: { field: 'input.fees' },
    });
    expect(
      await rejection(
        asAgent(world, () =>
          world.useCases.createPartner.execute({ idempotencyKey: 'partner-0001', input: partnerInput() }),
        ),
      ),
    ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it("n'active qu'après vérification, suspend avec un motif, garde le métier", async () => {
    const world = litigationWorld();
    const created = await asLegal(world, () =>
      world.useCases.createPartner.execute({
        idempotencyKey: 'partner-0001',
        input: partnerInput({ verificationFileId: '' }),
      }),
    );
    const update = (input: Parameters<typeof world.useCases.updatePartner.execute>[0]) =>
      asLegal(world, () => world.useCases.updatePartner.execute(input));
    const id = created.partner.id;
    expect(
      await rejection(update({ partnerId: id, input: null, status: 'suspended', statusReason: 'x' })),
    ).toMatchObject({
      code: 'RECOVERY_INVALID_TRANSITION',
    });
    expect(
      await rejection(update({ partnerId: id, input: null, status: 'active', statusReason: '' })),
    ).toMatchObject({
      code: 'RECOVERY_VALIDATION_FAILED',
      details: { field: 'input.verificationFileId' },
    });
    const active = await update({ partnerId: id, input: partnerInput(), status: 'active', statusReason: '' });
    expect(active.partner).toMatchObject({ status: 'active', verificationFileId: VERIFICATION_FILE });
    expect(active.partner.verifiedBy).not.toBeNull();
    expect(active.verifiedByName).toBe('Me Kossi Juriste');
    expect(
      await rejection(update({ partnerId: id, input: null, status: 'suspended', statusReason: '' })),
    ).toMatchObject({
      details: { field: 'statusReason' },
    });
    const suspended = await update({
      partnerId: id,
      input: null,
      status: 'suspended',
      statusReason: 'Radiation',
    });
    expect(suspended.partner).toMatchObject({ status: 'suspended', statusReason: 'Radiation' });
    expect(
      await rejection(
        update({ partnerId: id, input: partnerInput({ kind: 'lawyer' }), status: '', statusReason: '' }),
      ),
    ).toMatchObject({ details: { field: 'input.kind' } });
    expect(world.litigation.partnerAudit.map((entry) => entry.action)).toEqual([
      'partner.created',
      'partner.activated',
      'partner.suspended',
    ]);
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.getPartner.execute({ partnerId: '0192f1c4-0000-7000-8000-00000000dead' }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_PARTNER_NOT_FOUND' });
  });

  it('liste par commune et propose le partenaire du ressort le moins chargé (R-HU-02)', async () => {
    const world = litigationWorld();
    const record = await activeCase(world);
    const busy = await activePartner(world, 'partner-0001', { name: 'Me Occupé' });
    const free = await activePartner(world, 'partner-0002', {
      name: 'Me Libre',
      userId: OTHER_BAILIFF_USER_ID,
      verificationFileId: VERIFICATION_FILE_2,
    });
    const far = await activePartner(world, 'partner-0003', {
      name: 'Me Lointain',
      userId: '',
      communeKeys: ['porto-novo'],
      verificationFileId: '0192f1c4-0000-7000-8000-0000000fe021',
    });
    world.litigation.assignmentRows.set('0192f1c4-0000-7000-8000-00000000a551', {
      id: '0192f1c4-0000-7000-8000-00000000a551',
      caseId: record.id,
      partnerId: busy.partner.id,
      status: 'active',
      assignedBy: 'x',
      assignedAt: new Date('2026-11-01T00:00:00Z'),
      note: null,
      quoteDocumentId: null,
      lastUpdateAt: new Date('2026-11-01T00:00:00Z'),
      withdrawnAt: null,
      withdrawReason: null,
      completedAt: null,
    });
    const suggestions = await asLegal(world, () =>
      world.useCases.suggestPartners.execute({ caseId: record.id, kind: 'bailiff' }),
    );
    expect(suggestions.map((s) => [s.view.partner.name, s.rank, s.coversDebtorArea])).toEqual([
      ['Me Libre', 1, true],
      ['Me Occupé', 2, true],
      ['Me Lointain', 3, false],
    ]);
    expect(suggestions[1]?.view.stats.openAssignments).toBe(1);
    const listed = await asSupervisor(world, () =>
      world.useCases.listPartners.execute({
        kind: 'bailiff',
        statuses: ['active'],
        communeKey: 'porto-novo',
      }),
    );
    expect(listed.items.map((item) => item.partner.id)).toEqual([far.partner.id]);
    expect(free.partner.id).toBeDefined();
  });
});
