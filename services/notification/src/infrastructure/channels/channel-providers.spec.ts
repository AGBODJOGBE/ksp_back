import { ConfigError, loadConfig } from '@ksp/platform';
import { configSchema, emailProviderKind, type ServiceConfig, whatsappProviderKind } from '../../config';
import { BrevoEmailProvider } from './brevo-email.provider';
import { createChannelProviders } from './channel-providers';
import { ConsoleEmailProvider } from './console-email.provider';
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
const BREVO = { BREVO_API_KEY: 'xkeysib-secret', EMAIL_SENDER_ADDRESS: 'notifications@ksp.bj' };
const PRODUCTION = {
  NODE_ENV: 'production',
  IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
  IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
  SERVICE_CLIENT_SECRET: 'secret-de-notification',
  ...BREVO,
};

const config = (env: Record<string, string>) => loadConfig(configSchema, { ...BASE, ...env });

describe('Choix du prestataire WhatsApp', () => {
  it('console par défaut hors production (développement sans téléphone)', () => {
    const cfg = config({ NODE_ENV: 'development' });
    expect(whatsappProviderKind(cfg)).toBe('console');
    expect(createChannelProviders(cfg)).toEqual([
      expect.any(ConsoleWhatsAppProvider),
      expect.any(ConsoleEmailProvider),
    ]);
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
    expect(createChannelProviders(cfg)[0]).toBeInstanceOf(MetaWhatsAppProvider);
  });

  it('meta par défaut en production', () => {
    const cfg = config({ ...PRODUCTION, ...META });
    expect(whatsappProviderKind(cfg)).toBe('meta');
    expect(createChannelProviders(cfg)[0]).toBeInstanceOf(MetaWhatsAppProvider);
  });
});

describe('Jeton de service vers identity', () => {
  it('obligatoire en production : notification lit les destinataires dans identity', () => {
    const { SERVICE_CLIENT_SECRET: _secret, ...withoutSecret } = PRODUCTION;
    expect(() => config({ ...withoutSecret, ...META })).toThrow(/SERVICE_CLIENT_SECRET/);
    expect(() => config({ ...PRODUCTION, ...META })).not.toThrow();
  });
});

describe('Choix du prestataire e-mail', () => {
  it('console par défaut hors production', () => {
    const cfg = config({ NODE_ENV: 'development', NOTIFICATION_EMAIL_PROVIDER: '' });
    expect(emailProviderKind(cfg)).toBe('console');
    expect(createChannelProviders(cfg)[1]).toBeInstanceOf(ConsoleEmailProvider);
  });

  it('brevo quand il est demandé, avec les valeurs par défaut', () => {
    const cfg = config({ NODE_ENV: 'development', NOTIFICATION_EMAIL_PROVIDER: 'brevo', ...BREVO });
    expect(cfg).toMatchObject({ EMAIL_SENDER_NAME: 'Groupe KSP', EMAIL_TIMEOUT_MS: 5000 });
    expect(createChannelProviders(cfg)[1]).toBeInstanceOf(BrevoEmailProvider);
  });

  it('brevo par défaut en production', () => {
    const cfg = config({ ...PRODUCTION, ...META });
    expect(emailProviderKind(cfg)).toBe('brevo');
    expect(createChannelProviders(cfg)).toEqual([
      expect.any(MetaWhatsAppProvider),
      expect.any(BrevoEmailProvider),
    ]);
  });

  it('brevo sans clé ou sans expéditeur : refus au démarrage', () => {
    const { BREVO_API_KEY: _key, ...withoutKey } = PRODUCTION;
    expect(() => config({ ...withoutKey, ...META })).toThrow(/BREVO_API_KEY/);
    expect(() =>
      config({ NODE_ENV: 'development', NOTIFICATION_EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k' }),
    ).toThrow(ConfigError);
    const forged = {
      ...config({ NODE_ENV: 'development' }),
      NOTIFICATION_EMAIL_PROVIDER: 'brevo',
    } as ServiceConfig;
    expect(() => createChannelProviders(forged)).toThrow('BREVO_API_KEY');
  });

  it('adresse d’expédition mal formée : refus au démarrage', () => {
    expect(() => config({ NODE_ENV: 'development', EMAIL_SENDER_ADDRESS: 'ksp.bj' })).toThrow(
      /EMAIL_SENDER_ADDRESS/,
    );
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

  it('le service refuse de démarrer avec l’e-mail console en production', () => {
    expect(() => config({ ...PRODUCTION, ...META, NOTIFICATION_EMAIL_PROVIDER: 'console' })).toThrow(
      /NOTIFICATION_EMAIL_PROVIDER/,
    );
    const forged = {
      ...config({ NODE_ENV: 'development', NOTIFICATION_WHATSAPP_PROVIDER: 'meta', ...META }),
      NOTIFICATION_EMAIL_PROVIDER: 'console',
      NODE_ENV: 'production',
    } as ServiceConfig;
    expect(() => createChannelProviders(forged)).toThrow('e-mail « console » est interdit en production');
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
