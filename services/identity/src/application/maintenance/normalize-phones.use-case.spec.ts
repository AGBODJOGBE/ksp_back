import { formatReport } from '../../cli/normalize-phones';
import {
  maskStoredPhone,
  NormalizePhonesUseCase,
  type PhoneNormalizationStore,
  type PhoneRewriteOutcome,
  type StoredPhone,
} from './normalize-phones.use-case';

/** Table user_phones en mémoire, avec la contrainte d'unicité de phone_e164. */
class InMemoryPhones implements PhoneNormalizationStore {
  readonly rows: StoredPhone[];
  /** Simule une écriture concurrente juste avant la réécriture d'une ligne. */
  beforeRewrite: ((id: string) => void) | null = null;

  constructor(rows: [string, string, string][]) {
    this.rows = rows.map(([id, userId, phoneE164]) => ({ id, userId, phoneE164 }));
  }

  async page(afterId: string | null, limit: number): Promise<StoredPhone[]> {
    return [...this.rows]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((row) => afterId === null || row.id > afterId)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async findByNumber(phoneE164: string): Promise<StoredPhone | null> {
    const row = this.rows.find((candidate) => candidate.phoneE164 === phoneE164);
    return row ? { ...row } : null;
  }

  async rewrite(id: string, from: string, to: string): Promise<PhoneRewriteOutcome> {
    this.beforeRewrite?.(id);
    const row = this.rows.find((candidate) => candidate.id === id && candidate.phoneE164 === from);
    if (!row) return 'changed';
    if (this.rows.some((candidate) => candidate.phoneE164 === to)) return 'taken';
    row.phoneE164 = to;
    return 'rewritten';
  }

  numbers(): string[] {
    return this.rows.map((row) => row.phoneE164);
  }
}

const demo = () =>
  new InMemoryPhones([
    ['p1', 'u1', '+22997000101'],
    ['p2', 'u2', '+22997000102'],
    ['p3', 'u3', '+2290197000103'],
    ['p4', 'u4', '+33612345678'],
    ['p5', 'u5', '+22890000105'],
  ]);

describe('NormalizePhonesUseCase (script phones:normalize, ADR-063)', () => {
  it('réécrit les numéros béninois à 8 chiffres, garde les autres', async () => {
    const store = demo();
    const report = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(store.numbers()).toEqual([
      '+2290197000101',
      '+2290197000102',
      '+2290197000103',
      '+33612345678',
      '+22890000105',
    ]);
    expect(report).toMatchObject({ applied: true, scanned: 5, alreadyNormalized: 3, conflicts: [] });
    expect(report.changes).toEqual([
      { phoneId: 'p1', userId: 'u1', from: '+229******01', to: '+229********01' },
      { phoneId: 'p2', userId: 'u2', from: '+229******02', to: '+229********02' },
    ]);
  });

  it('est idempotent : un second passage ne réécrit rien', async () => {
    const store = demo();
    await new NormalizePhonesUseCase(store).execute({ apply: true });
    const after = store.numbers();
    const second = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(second).toMatchObject({ scanned: 5, alreadyNormalized: 5, changes: [], conflicts: [] });
    expect(store.numbers()).toEqual(after);
  });

  it('sans --apply, annonce les réécritures sans rien écrire', async () => {
    const store = demo();
    const report = await new NormalizePhonesUseCase(store).execute({ apply: false });
    expect(report.applied).toBe(false);
    expect(report.changes.map((change) => change.phoneId)).toEqual(['p1', 'p2']);
    expect(store.numbers()).toEqual(demo().numbers());
  });

  it('refuse une réécriture qui créerait un doublon et la rapporte', async () => {
    const store = new InMemoryPhones([
      ['p1', 'u1', '+22997000101'],
      ['p2', 'u2', '+2290197000101'],
      ['p3', 'u3', '+22997000103'],
    ]);
    const report = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(store.numbers()).toEqual(['+22997000101', '+2290197000101', '+2290197000103']);
    expect(report.conflicts).toEqual([
      { phoneId: 'p1', userId: 'u1', from: '+229******01', to: '+229********01', holderUserId: 'u2' },
    ]);
    expect(report.changes.map((change) => change.phoneId)).toEqual(['p3']);
    // Le conflit reste signalé à chaque passage, sans autre écriture.
    const again = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(again.conflicts).toHaveLength(1);
    expect(again.changes).toEqual([]);
  });

  it('rapporte un conflit apparu entre la vérification et l’écriture', async () => {
    const store = new InMemoryPhones([['p1', 'u1', '+22997000101']]);
    store.beforeRewrite = () => {
      store.rows.push({ id: 'p9', userId: 'u9', phoneE164: '+2290197000101' });
    };
    const report = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(report.conflicts).toEqual([expect.objectContaining({ phoneId: 'p1', holderUserId: 'u9' })]);
    expect(store.rows[0].phoneE164).toBe('+22997000101');
  });

  it('laisse une ligne modifiée pendant le passage et une valeur illisible', async () => {
    const store = new InMemoryPhones([
      ['p1', 'u1', '+22997000101'],
      ['p2', 'u2', 'pas un numéro'],
    ]);
    store.beforeRewrite = (id) => {
      store.rows.find((row) => row.id === id)!.phoneE164 = '+33612345678';
    };
    const report = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(report.skipped.map((change) => change.phoneId)).toEqual(['p1']);
    expect(report.unreadable).toEqual([{ phoneId: 'p2', userId: 'u2' }]);
    expect(store.numbers()).toEqual(['+33612345678', 'pas un numéro']);
  });

  it('parcourt la table par lots', async () => {
    const rows: [string, string, string][] = Array.from({ length: 1203 }, (_, i) => [
      `p${String(i).padStart(5, '0')}`,
      `u${i}`,
      `+2299${String(i).padStart(7, '0')}`,
    ]);
    const store = new InMemoryPhones(rows);
    const report = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(report.scanned).toBe(1203);
    expect(report.changes).toHaveLength(1203);
    expect(store.numbers().every((phone) => /^\+22901\d{8}$/.test(phone))).toBe(true);
  });

  it('masque toute valeur enregistrée', () => {
    expect(maskStoredPhone('+22997000101')).toBe('+229******01');
    expect(maskStoredPhone('+2290197000101')).toBe('+229********01');
    expect(maskStoredPhone('abc')).toBe('***');
  });

  it('le rapport du script sort en erreur tant qu’un conflit reste', async () => {
    const clean = formatReport(await new NormalizePhonesUseCase(demo()).execute({ apply: false }));
    expect(clean.exitCode).toBe(0);
    expect(clean.text).toContain('À réécrire : 2');
    expect(clean.text).not.toContain('97000101');

    const store = new InMemoryPhones([
      ['p1', 'u1', '+22997000101'],
      ['p2', 'u2', '+2290197000101'],
    ]);
    const conflicted = formatReport(await new NormalizePhonesUseCase(store).execute({ apply: true }));
    expect(conflicted.exitCode).toBe(1);
    expect(conflicted.text).toContain('Conflits (réécriture refusée, doublon) : 1');
    expect(conflicted.text).toContain('numéro déjà porté par u2');
  });
});
