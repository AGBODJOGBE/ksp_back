import {
  approvalStatus,
  approveCredit,
  type ClaimState,
  CREDIT_APPROVAL_THRESHOLD,
  decideClaim,
  openClaim,
  redoSlot,
  staffUpdate,
  customerMessage,
} from './claim';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T10:00:00+01:00');

const claim = (extra: Partial<ClaimState> = {}): ClaimState => ({
  status: 'open',
  decision: null,
  creditAmount: null,
  decidedBy: null,
  creditApprovedBy: null,
  firstResponseAt: null,
  ...extra,
});

describe('R-RC-01 : déposer une réclamation sur une séance réalisée, pendant 48 h', () => {
  const session = { status: 'completed', completedAt: at('2026-11-19T10:00:00+01:00') };
  const input = { category: 'damage', text: 'Vase cassé', photoFileIds: [] };

  it('cas nominal : séance réalisée la veille', () => {
    expect(openClaim(session, input, NOW, 48)).toEqual({ ok: true, value: { ...input, text: 'Vase cassé' } });
  });

  it('cas limite : fenêtre dépassée (48 h pile comprises)', () => {
    expect(openClaim(session, input, at('2026-11-21T10:00:00+01:00'), 48).ok).toBe(true);
    expect(openClaim(session, input, at('2026-11-21T10:00:01+01:00'), 48)).toEqual({
      ok: false,
      error: { code: 'CLEANING_CLAIM_WINDOW_CLOSED', details: { windowHours: 48 } },
    });
  });

  it('cas limite : séance non réalisée', () => {
    expect(openClaim({ status: 'assigned', completedAt: null }, input, NOW, 48)).toEqual({
      ok: false,
      error: { code: 'CLEANING_INVALID_TRANSITION', details: { from: 'assigned', to: 'claimed' } },
    });
  });

  it('cas limite : motif inconnu, texte vide ou trop long, trop de photos', () => {
    expect(openClaim(session, { ...input, category: 'noise' }, NOW, 48)).toMatchObject({
      error: { details: { field: 'category', reason: 'invalid_type' } },
    });
    expect(openClaim(session, { ...input, text: '  ' }, NOW, 48)).toMatchObject({
      error: { details: { field: 'text', reason: 'required' } },
    });
    expect(openClaim(session, { ...input, text: 'x'.repeat(2001) }, NOW, 48)).toMatchObject({
      error: { details: { field: 'text', reason: 'out_of_range' } },
    });
    const photos = Array.from({ length: 11 }, (_, i) => `p${i}`);
    expect(openClaim(session, { ...input, photoFileIds: photos }, NOW, 48)).toMatchObject({
      error: { details: { field: 'photoFileIds', reason: 'out_of_range' } },
    });
  });
});

describe('R-RC-02 : échanges et prise en charge', () => {
  it('cas nominal : le client répond sur une réclamation ouverte ou en cours', () => {
    expect(customerMessage(claim(), 'Merci')).toEqual({ ok: true, value: 'Merci' });
    expect(customerMessage(claim({ status: 'in_progress' }), 'Merci').ok).toBe(true);
  });

  it('cas limite : réclamation close ; message vide', () => {
    expect(customerMessage(claim({ status: 'resolved' }), 'Merci')).toMatchObject({
      ok: false,
      error: { code: 'CLEANING_INVALID_TRANSITION' },
    });
    expect(customerMessage(claim(), '')).toMatchObject({ error: { details: { field: 'text' } } });
  });

  it('prise en charge : ouverte → en cours, première réponse datée une seule fois', () => {
    expect(staffUpdate(claim(), { status: 'in_progress', message: null }, NOW)).toEqual({
      ok: true,
      value: { status: 'in_progress', message: null, firstResponseAt: NOW },
    });
    const later = at('2026-11-21T10:00:00+01:00');
    expect(
      staffUpdate(
        claim({ status: 'in_progress', firstResponseAt: NOW }),
        { status: null, message: 'Vu' },
        later,
      ),
    ).toEqual({ ok: true, value: { status: 'in_progress', message: 'Vu', firstResponseAt: NOW } });
  });

  it('cas limite : rien à faire, statut autre que « en cours », réclamation close', () => {
    expect(staffUpdate(claim(), { status: null, message: null }, NOW)).toMatchObject({
      error: { details: { field: 'message', reason: 'required' } },
    });
    expect(staffUpdate(claim(), { status: 'resolved', message: null }, NOW)).toMatchObject({
      error: { details: { field: 'status', reason: 'invalid_type' } },
    });
    expect(staffUpdate(claim({ status: 'rejected' }), { status: null, message: 'x' }, NOW)).toMatchObject({
      error: { code: 'CLEANING_INVALID_TRANSITION' },
    });
  });
});

describe('R-RC-03 : décision', () => {
  it('repasse gratuite et rejet : réclamation close', () => {
    expect(
      decideClaim(claim(), { outcome: 'free_redo', creditAmount: null, reason: 'Refaite' }, 'u1'),
    ).toEqual({
      ok: true,
      value: {
        outcome: 'free_redo',
        creditAmount: null,
        reason: 'Refaite',
        status: 'resolved',
        pendingApproval: false,
      },
    });
    expect(
      decideClaim(claim(), { outcome: 'rejected', creditAmount: null, reason: 'Non fondée' }, 'u1'),
    ).toMatchObject({
      ok: true,
      value: { status: 'rejected', pendingApproval: false },
    });
  });

  it('crédit jusqu’à 50 000 FCFA : versé aussitôt ; au-delà : en attente d’une deuxième personne', () => {
    const small = decideClaim(
      claim(),
      { outcome: 'wallet_credit', creditAmount: CREDIT_APPROVAL_THRESHOLD, reason: 'Geste' },
      'u1',
    );
    expect(small).toMatchObject({ ok: true, value: { status: 'resolved', pendingApproval: false } });
    const big = decideClaim(
      claim(),
      { outcome: 'wallet_credit', creditAmount: 50_001, reason: 'Geste' },
      'u1',
    );
    expect(big).toMatchObject({ ok: true, value: { status: 'in_progress', pendingApproval: true } });
  });

  it('cas limite : motif obligatoire, montant pour le seul crédit, positif', () => {
    expect(
      decideClaim(claim(), { outcome: 'rejected', creditAmount: null, reason: ' ' }, 'u1'),
    ).toMatchObject({
      error: { details: { field: 'reason', reason: 'required' } },
    });
    expect(
      decideClaim(claim(), { outcome: 'wallet_credit', creditAmount: null, reason: 'x' }, 'u1'),
    ).toMatchObject({
      error: { details: { field: 'creditAmount', reason: 'required' } },
    });
    expect(
      decideClaim(claim(), { outcome: 'wallet_credit', creditAmount: 0, reason: 'x' }, 'u1'),
    ).toMatchObject({
      error: { details: { field: 'creditAmount', reason: 'out_of_range' } },
    });
    expect(decideClaim(claim(), { outcome: 'free_redo', creditAmount: 10, reason: 'x' }, 'u1')).toMatchObject(
      {
        error: { details: { field: 'creditAmount', reason: 'not_applicable' } },
      },
    );
    expect(
      decideClaim(claim(), { outcome: 'other' as never, creditAmount: null, reason: 'x' }, 'u1'),
    ).toMatchObject({
      error: { details: { field: 'outcome', reason: 'invalid_type' } },
    });
  });

  it('cas limite : déjà décidée, ou close', () => {
    expect(
      decideClaim(
        claim({ status: 'in_progress', decision: 'wallet_credit' }),
        { outcome: 'rejected', creditAmount: null, reason: 'x' },
        'u1',
      ),
    ).toMatchObject({ error: { code: 'CLEANING_INVALID_TRANSITION' } });
    expect(
      decideClaim(
        claim({ status: 'resolved' }),
        { outcome: 'rejected', creditAmount: null, reason: 'x' },
        'u1',
      ),
    ).toMatchObject({ error: { code: 'CLEANING_INVALID_TRANSITION', details: { from: 'resolved' } } });
  });
});

describe('R-RC-03, R-WL-04 : validation du crédit par une deuxième personne', () => {
  const pending = claim({
    status: 'in_progress',
    decision: 'wallet_credit',
    creditAmount: 80_000,
    decidedBy: 'u1',
  });

  it('cas nominal : une autre personne valide', () => {
    expect(approvalStatus(pending)).toBe('pending');
    expect(approveCredit(pending, 'u2')).toEqual({ ok: true, value: { status: 'resolved' } });
    expect(approvalStatus({ ...pending, creditApprovedBy: 'u2', status: 'resolved' })).toBe('approved');
  });

  it('cas limite : l’auteur ne valide pas sa propre décision ; rien à valider', () => {
    expect(approveCredit(pending, 'u1')).toEqual({
      ok: false,
      error: { code: 'CLEANING_SECOND_APPROVER_REQUIRED', details: {} },
    });
    expect(
      approveCredit(claim({ status: 'resolved', decision: 'free_redo', decidedBy: 'u1' }), 'u2'),
    ).toMatchObject({
      error: { code: 'CLEANING_INVALID_TRANSITION' },
    });
    expect(
      approvalStatus(claim({ decision: 'wallet_credit', creditAmount: 1_000, status: 'resolved' })),
    ).toBe('not_required');
    expect(approvalStatus(claim())).toBe('not_required');
  });
});

describe('repasse gratuite : créneau de la séance ajoutée', () => {
  const claimed = { start: at('2026-11-19T09:00:00+01:00'), end: at('2026-11-19T11:00:00+01:00') };

  it('cas nominal : même heure, premier jour au moins 48 h après la décision', () => {
    expect(redoSlot(claimed, NOW, 48, [])).toEqual({
      start: at('2026-11-23T09:00:00+01:00'),
      end: at('2026-11-23T11:00:00+01:00'),
    });
  });

  it('cas limite : une séance du programme déjà ce jour-là : le jour suivant', () => {
    const busy = [{ start: at('2026-11-23T10:00:00+01:00'), end: at('2026-11-23T12:00:00+01:00') }];
    expect(redoSlot(claimed, NOW, 48, busy).start).toEqual(at('2026-11-24T09:00:00+01:00'));
  });
});
