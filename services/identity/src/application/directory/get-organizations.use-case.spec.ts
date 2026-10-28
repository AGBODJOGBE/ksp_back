import { type Organization } from '../../domain/organization/organization';
import {
  GetOrganizationsUseCase,
  MAX_ORGANIZATION_IDS,
  type OrganizationDirectory,
} from './get-organizations.use-case';

const ORG_1 = '0192f1c4-0000-7000-8000-00000000a001';
const ORG_2 = '0192f1c4-0000-7000-8000-00000000a002';

const organization = (id: string, overrides: Partial<Organization> = {}): Organization => ({
  id,
  legalName: 'SARL Bénin Propre',
  address: 'Lot 12, Haie Vive, Cotonou',
  ifu: '3201912345678',
  rccm: 'RB/COT/19 B 1234',
  billingEmail: 'compta@benin-propre.bj',
  status: 'active',
  createdBy: '0192f1c4-0000-7000-8000-000000000001',
  createdAt: new Date('2026-10-27T09:00:00Z'),
  reviewedBy: '0192f1c4-0000-7000-8000-000000000009',
  reviewedAt: new Date('2026-10-27T10:00:00Z'),
  rejectionReason: null,
  suspendedAt: null,
  suspensionReason: null,
  ...overrides,
});

function useCase() {
  const lookups: string[][] = [];
  const directory: OrganizationDirectory = {
    findByIds: async (ids) => {
      lookups.push([...ids]);
      return [
        organization(ORG_1),
        organization(ORG_2, { status: 'suspended', rccm: null, billingEmail: null }),
      ].filter((candidate) => ids.includes(candidate.id));
    },
  };
  return { lookups, organizations: new GetOrganizationsUseCase(directory) };
}

describe('GetOrganizationsUseCase', () => {
  it('rend à notification les fiches avec l’e-mail de facturation, tous états confondus', async () => {
    const { organizations } = useCase();
    const found = await organizations.many('notification', [ORG_1, ORG_2]);
    expect(found.map((candidate) => [candidate.id, candidate.status, candidate.billingEmail])).toEqual([
      [ORG_1, 'active', 'compta@benin-propre.bj'],
      [ORG_2, 'suspended', null],
    ]);
  });

  it('rend à billing l’en-tête sans l’e-mail de facturation', async () => {
    const { organizations } = useCase();
    const [found] = await organizations.many('billing', [ORG_1]);
    expect(found).toMatchObject({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 12, Haie Vive, Cotonou',
      ifu: '3201912345678',
      rccm: 'RB/COT/19 B 1234',
      billingEmail: null,
    });
  });

  it('omet les identifiants inconnus ; dédoublonne et normalise avant la lecture', async () => {
    const { organizations, lookups } = useCase();
    const found = await organizations.many('billing', [
      ORG_1,
      ` ${ORG_1.toUpperCase()} `,
      '0192f1c4-0000-7000-8000-0000000000ff',
    ]);
    expect(found.map((candidate) => candidate.id)).toEqual([ORG_1]);
    expect(lookups).toEqual([[ORG_1, '0192f1c4-0000-7000-8000-0000000000ff']]);
  });

  it('refuse un service non autorisé, sans lire la base', async () => {
    const { organizations, lookups } = useCase();
    for (const caller of ['gateway', 'recovery', 'constructor']) {
      await expect(organizations.many(caller, [ORG_1])).rejects.toMatchObject({
        code: 'IDENTITY_CALLER_FORBIDDEN',
      });
    }
    expect(lookups).toEqual([]);
  });

  it('rend la raison sociale à cleaning, sans l’e-mail de facturation (ADR-029)', async () => {
    const { organizations } = useCase();
    await expect(organizations.many('cleaning', [ORG_1])).resolves.toMatchObject([
      { id: ORG_1, legalName: expect.any(String), billingEmail: null },
    ]);
  });

  it('accepte un appel sans jeton de service vérifié (développement)', async () => {
    const { organizations } = useCase();
    await expect(organizations.many(null, [ORG_1])).resolves.toMatchObject([
      { id: ORG_1, billingEmail: 'compta@benin-propre.bj' },
    ]);
  });

  it('refuse un identifiant mal formé et un appel trop volumineux', async () => {
    const { organizations } = useCase();
    await expect(organizations.many('billing', ['pas-un-uuid'])).rejects.toMatchObject({
      code: 'IDENTITY_ORGANIZATION_ID_INVALID',
    });
    const tooMany = Array.from({ length: MAX_ORGANIZATION_IDS + 1 }, () => ORG_1);
    await expect(organizations.many('billing', tooMany)).rejects.toMatchObject({
      code: 'IDENTITY_TOO_MANY_ORGANIZATION_IDS',
    });
  });

  it('rend une liste vide sans lire la base quand aucun identifiant n’est demandé', async () => {
    const { organizations, lookups } = useCase();
    await expect(organizations.many('notification', [])).resolves.toEqual([]);
    expect(lookups).toEqual([]);
  });
});
