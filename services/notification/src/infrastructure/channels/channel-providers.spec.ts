import { ConfigError, loadConfig } from '@ksp/platform';
import { configSchema, type ServiceConfig, whatsappProviderKind } from '../../config';
import { createChannelProviders } from './channel-providers';
import { ConsoleWhatsAppProvider } from './console-whatsapp.provider';
import { MetaWhatsAppProvider } from './meta-whatsapp.provider';

const BASE = {
  SERVICE_NAME: 'notification',
  GRPC_PORT: '50052',
  HTTP_PORT: '3102',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};

const META = { WHATSAPP_ACCESS_TOKEN: 'jeton', WHATSAPP_PHONE_NUMBER_ID: '106540352242922' };
const PRODUCTION = {
  NODE_ENV: 'production',
  IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
};

const config = (env: Record<string, string>) => loadConfig(configSchema, { ...BASE, ...env });

describe('Choix du prestataire WhatsApp', () => {
  it('console par défaut hors production (développement sans téléphone)', () => {
    const cfg = config({ NODE_ENV: 'development' });
    expect(whatsappProviderKind(cfg)).toBe('console');
    expect(createChannelProviders(cfg)).toEqual([expect.any(ConsoleWhatsAppProvider)]);
  });

  it('une variable vide vaut le choix par défaut', () => {
    expect(whatsappProviderKind(config({ NODE_ENV: 'test', NOTIFICATION_WHATSAPP_PROVIDER: '' }))).toBe(
      'console',
    );
  });

  it('meta quand il est demandé, avec les valeurs par défaut du modèle', () => {
    const cfg = config({ NODE_ENV: 'development', NOTIFICATION_WHATSAPP_PROVIDER: 'meta', ...META });
    expect(cfg).toMatchObject({
      WHATSAPP_API_VERSION: 'v23.0',
      WHATSAPP_OTP_TEMPLATE: 'ksp_otp',
      WHATSAPP_TEMPLATE_LANGUAGE: 'fr',
      WHATSAPP_TIMEOUT_MS: 2000,
    });
    expect(createChannelProviders(cfg)).toEqual([expect.any(MetaWhatsAppProvider)]);
  });

  it('meta par défaut en production', () => {
    const cfg = config({ ...PRODUCTION, ...META });
    expect(whatsappProviderKind(cfg)).toBe('meta');
    expect(createChannelProviders(cfg)).toEqual([expect.any(MetaWhatsAppProvider)]);
  });
});

describe('Garde-fou de production', () => {
  it('le service refuse de démarrer avec le prestataire console en production', () => {
    expect(() => config({ ...PRODUCTION, ...META, NOTIFICATION_WHATSAPP_PROVIDER: 'console' })).toThrow(
      ConfigError,
    );
    expect(() => config({ ...PRODUCTION, ...META, NOTIFICATION_WHATSAPP_PROVIDER: 'console' })).toThrow(
      /NOTIFICATION_WHATSAPP_PROVIDER/,
    );
  });

  it('la fabrique refuse aussi une configuration construite sans le schéma', () => {
    const forged = {
      ...config({ NODE_ENV: 'development', NOTIFICATION_WHATSAPP_PROVIDER: 'console' }),
      NODE_ENV: 'production',
    } as ServiceConfig;
    expect(() => createChannelProviders(forged)).toThrow('interdit en production');
  });

  it('meta sans jeton ni numéro : refus au démarrage', () => {
    expect(() => config(PRODUCTION)).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    expect(() => config({ NODE_ENV: 'development', NOTIFICATION_WHATSAPP_PROVIDER: 'meta' })).toThrow(
      ConfigError,
    );
    const forged = {
      ...config({ NODE_ENV: 'development' }),
      NOTIFICATION_WHATSAPP_PROVIDER: 'meta',
    } as ServiceConfig;
    expect(() => createChannelProviders(forged)).toThrow('WHATSAPP_ACCESS_TOKEN');
  });

  it('version de l’API Graph mal formée : refus au démarrage', () => {
    expect(() => config({ NODE_ENV: 'development', WHATSAPP_API_VERSION: '23' })).toThrow(
      /WHATSAPP_API_VERSION/,
    );
  });
});
