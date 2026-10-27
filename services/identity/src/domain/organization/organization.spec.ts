import {
  acceptsBillingEmail,
  canBeActiveContext,
  decide,
  needsReason,
  normalizeAddress,
  normalizeIfu,
  normalizeLegalName,
  normalizeRccm,
  normalizeReason,
} from './organization';

describe('Organisation : fiche entreprise', () => {
  it('IFU : 13 chiffres, espaces ignorés, sans contrôle de clé', () => {
    expect(normalizeIfu('3201912345678')).toBe('3201912345678');
    expect(normalizeIfu(' 3201 9123 45678 ')).toBe('3201912345678');
    expect(normalizeIfu('320191234567')).toBeNull();
    expect(normalizeIfu('32019123456789')).toBeNull();
    expect(normalizeIfu('320191234567A')).toBeNull();
    expect(normalizeIfu('')).toBeNull();
  });

  it('RCCM : forme souple, mise en majuscules', () => {
    expect(normalizeRccm(' rb/cot/19  b 12345 ')).toBe('RB/COT/19 B 12345');
    expect(normalizeRccm('RB-PNO-2021-A-0042')).toBe('RB-PNO-2021-A-0042');
    expect(normalizeRccm('ab')).toBeNull();
    expect(normalizeRccm('RB/COT<script>')).toBeNull();
  });

  it('raison sociale et adresse : une ligne, espaces en trop retirés, longueur bornée', () => {
    expect(normalizeLegalName('  SARL   Bénin Propre ')).toBe('SARL Bénin Propre');
    expect(normalizeLegalName('---')).toBeNull();
    expect(normalizeLegalName('A')).toBeNull();
    expect(normalizeLegalName('x'.repeat(201))).toBeNull();
    expect(normalizeLegalName('SARL\u0000Propre')).toBeNull();
    expect(normalizeAddress('Lot 1234, Haie Vive,\nCotonou')).toBe('Lot 1234, Haie Vive, Cotonou');
    expect(normalizeAddress('ici')).toBeNull();
  });

  it('motif : obligatoire et borné', () => {
    expect(normalizeReason('  IFU introuvable  ')).toBe('IFU introuvable');
    expect(normalizeReason('   ')).toBeNull();
    expect(normalizeReason('x'.repeat(501))).toBeNull();
  });
});

describe('Organisation : décisions du back-office', () => {
  it('valider ou refuser une demande en attente', () => {
    expect(decide('pending_review', 'validate')).toBe('active');
    expect(decide('pending_review', 'reject')).toBe('rejected');
    expect(decide('active', 'validate')).toBeNull();
    expect(decide('rejected', 'validate')).toBeNull();
  });

  it('suspendre une organisation validée, puis la réactiver', () => {
    expect(decide('active', 'suspend')).toBe('suspended');
    expect(decide('suspended', 'reactivate')).toBe('active');
    expect(decide('pending_review', 'suspend')).toBeNull();
    expect(decide('active', 'reactivate')).toBeNull();
  });

  it('le refus et la suspension exigent un motif', () => {
    expect(needsReason('reject')).toBe(true);
    expect(needsReason('suspend')).toBe(true);
    expect(needsReason('validate')).toBe(false);
    expect(needsReason('reactivate')).toBe(false);
  });

  it('seule une organisation validée devient un contexte actif', () => {
    expect(canBeActiveContext('active')).toBe(true);
    for (const status of ['pending_review', 'rejected', 'suspended'] as const) {
      expect(canBeActiveContext(status)).toBe(false);
    }
  });

  it('l’e-mail de facturation se déclare en attente ou après validation', () => {
    expect(acceptsBillingEmail('pending_review')).toBe(true);
    expect(acceptsBillingEmail('active')).toBe(true);
    expect(acceptsBillingEmail('rejected')).toBe(false);
    expect(acceptsBillingEmail('suspended')).toBe(false);
  });
});
