import { configSchema } from './config';

const ENV = {
  SERVICE_NAME: 'notification',
  NODE_ENV: 'test',
  GRPC_PORT: '50052',
  HTTP_PORT: '3102',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};
const SUPERVISOR = '0192F1C4-0000-7000-8000-00000000A001';

describe('Configuration du personnel du Nettoyage (RV-62)', () => {
  it('par défaut : aucun repli, aucun lien du back-office', () => {
    const config = configSchema.parse(ENV);
    expect(config.NOTIFICATION_CLEANING_STAFF_FALLBACK).toEqual({});
    expect(config.BACKOFFICE_BASE_URL).toBeUndefined();
  });

  it('repli par permission (JSON), identifiants en minuscules', () => {
    const config = configSchema.parse({
      ...ENV,
      NOTIFICATION_CLEANING_STAFF_FALLBACK: JSON.stringify({ 'cleaning.request.process': [SUPERVISOR] }),
      BACKOFFICE_BASE_URL: 'https://admin.ksp.bj',
    });
    expect(config.NOTIFICATION_CLEANING_STAFF_FALLBACK).toEqual({
      'cleaning.request.process': [SUPERVISOR.toLowerCase()],
    });
    expect(config.BACKOFFICE_BASE_URL).toBe('https://admin.ksp.bj');
  });

  it.each([
    ['JSON illisible', '{'],
    ['permission inconnue', JSON.stringify({ 'cleaning.catalog.manage': [] })],
    ['identifiant qui n’est pas un UUID', JSON.stringify({ 'cleaning.claim.manage': ['koffi'] })],
  ])('refuse un repli invalide : %s', (_case, value) => {
    expect(configSchema.safeParse({ ...ENV, NOTIFICATION_CLEANING_STAFF_FALLBACK: value }).success).toBe(
      false,
    );
  });

  it('en production, le back-office est une adresse HTTPS publique', () => {
    const production = {
      ...ENV,
      NODE_ENV: 'production',
      BACKOFFICE_BASE_URL: 'http://localhost:4200',
    };
    const result = configSchema.safeParse(production);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('BACKOFFICE_BASE_URL');
  });
});
