import {
  consumeProvisions,
  escalationRequest,
  feeQuoteTotals,
  manualClosure,
  noticeDeadline,
  partnerFitsStage,
  provisionRemainder,
  splitJournal,
} from './litigation';
import { type PartnerProfile, rankPartners } from './partner';

describe('contentieux : règles pures (lot R5)', () => {
  it('fait courir le délai de la mise en demeure depuis sa remise', () => {
    expect(noticeDeadline(new Date('2026-11-21T08:00:00Z'), 15)).toEqual(new Date('2026-12-06T08:00:00Z'));
  });

  it("n'ouvre une étape payante qu'à la suite de la précédente, ou en provision complémentaire", () => {
    const active = (stage: 'amicable' | 'formal_notice' | 'bailiff' | 'litigation') => ({
      status: 'active' as const,
      stage,
    });
    expect(escalationRequest(active('formal_notice'), 'bailiff', true)).toEqual({
      ok: true,
      value: 'escalation',
    });
    expect(escalationRequest(active('formal_notice'), 'bailiff', false)).toMatchObject({
      ok: false,
      code: 'RECOVERY_INVALID_TRANSITION',
    });
    expect(escalationRequest(active('bailiff'), 'litigation', false)).toEqual({
      ok: true,
      value: 'escalation',
    });
    expect(escalationRequest(active('bailiff'), 'bailiff', false)).toEqual({ ok: true, value: 'top_up' });
    expect(escalationRequest(active('amicable'), 'bailiff', true).ok).toBe(false);
    expect(escalationRequest(active('formal_notice'), 'litigation', true).ok).toBe(false);
    expect(escalationRequest({ status: 'suspended', stage: 'bailiff' }, 'bailiff', true).ok).toBe(false);
  });

  it("confie l'étape huissier à un huissier, la procédure judiciaire à un avocat ou à un huissier", () => {
    expect(partnerFitsStage('bailiff', 'bailiff')).toBe(true);
    expect(partnerFitsStage('lawyer', 'bailiff')).toBe(false);
    expect(partnerFitsStage('lawyer', 'litigation')).toBe(true);
    expect(partnerFitsStage('bailiff', 'litigation')).toBe(true);
  });

  it('demande en provision tout le devis : KSP n’avance aucun frais', () => {
    expect(
      feeQuoteTotals([
        { label: 'a', amount: 35_000 },
        { label: 'b', amount: 25_000 },
      ]),
    ).toEqual({
      ok: true,
      value: { total: 60_000, provision: 60_000 },
    });
    expect(feeQuoteTotals([]).ok).toBe(false);
    expect(feeQuoteTotals([{ label: 'a', amount: 0 }]).ok).toBe(false);
    expect(feeQuoteTotals([{ label: 'a', amount: 10.5 }]).ok).toBe(false);
  });

  it('impute les frais sur les provisions, la plus ancienne d’abord, et mesure le dépassement', () => {
    const provisions = [
      { id: 'p1', amount: 50_000, consumed: 40_000 },
      { id: 'p2', amount: 30_000, consumed: 0 },
    ];
    expect(consumeProvisions(provisions, 25_000)).toEqual({
      provisions: [
        { id: 'p1', amount: 50_000, consumed: 50_000 },
        { id: 'p2', amount: 30_000, consumed: 15_000 },
      ],
      overrun: 0,
    });
    expect(consumeProvisions(provisions, 60_000).overrun).toBe(20_000);
    expect(provisionRemainder(provisions)).toBe(40_000);
  });

  it('ne déclare « irrecouvrable » ou « prescrit » que sur ses conditions (R-PR-10)', () => {
    const none = { prescribed: false, insolvencyEstablished: false, noContactForLong: false };
    expect(manualClosure('abandoned_by_creditor', none)).toEqual({
      ok: true,
      value: 'abandoned_by_creditor',
    });
    expect(manualClosure('unrecoverable', none).ok).toBe(false);
    expect(manualClosure('unrecoverable', { ...none, insolvencyEstablished: true }).ok).toBe(true);
    expect(manualClosure('unrecoverable', { ...none, noContactForLong: true }).ok).toBe(true);
    expect(manualClosure('prescribed', none).ok).toBe(false);
    expect(manualClosure('prescribed', { ...none, prescribed: true }).ok).toBe(true);
  });

  it('découpe le journal à 1 000 entrées ou à la taille, la première limite atteinte', () => {
    const entries = Array.from({ length: 2_500 }, (_, index) => index);
    expect(splitJournal(entries, () => 10, 1_000, 1_000_000).map((part) => part.length)).toEqual([
      1_000, 1_000, 500,
    ]);
    expect(splitJournal(entries.slice(0, 10), () => 100, 1_000, 302).map((part) => part.length)).toEqual([
      3, 3, 3, 1,
    ]);
    expect(splitJournal([], () => 1, 1_000, 10)).toEqual([]);
  });

  it('classe les partenaires du ressort d’abord, puis les autres (R-HU-02)', () => {
    const profile = (id: string, areas: string[], openAssignments: number): PartnerProfile => ({
      id,
      kind: 'bailiff',
      status: 'active',
      areas,
      openAssignments,
      closedAssignments: 0,
      successfulAssignments: 0,
      averageDays: null,
    });
    const ranked = rankPartners(
      [
        profile('far', ['porto-novo'], 0),
        profile('busy', ['cotonou'], 3),
        profile('free', ['cotonou'], 0),
        { ...profile('off', ['cotonou'], 0), status: 'suspended' },
        { ...profile('lawyer', ['cotonou'], 0), kind: 'lawyer' },
      ],
      'bailiff',
      'cotonou',
    );
    expect(ranked.map((item) => [item.partner.id, item.coversArea])).toEqual([
      ['free', true],
      ['busy', true],
      ['far', false],
    ]);
    expect(rankPartners([profile('far', ['porto-novo'], 0)], 'bailiff', null)[0]?.coversArea).toBe(false);
  });
});
