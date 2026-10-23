import { Logger } from '@nestjs/common';
import { type OutgoingMessage } from '../../application/send/notification.ports';
import { BrevoEmailProvider, type BrevoEmailOptions } from './brevo-email.provider';

const API_KEY = 'xkeysib-0123456789abcdef-secret';
const ADDRESS = 'koffi.adjovi@example.com';

const message: OutgoingMessage = {
  notificationId: 'n-1',
  channel: 'email',
  templateCode: 'cleaning.quote_sent.customer',
  phoneE164: null,
  email: ADDRESS,
  variables: {},
  content: {
    subject: 'Votre devis de nettoyage',
    text: 'Bonjour Koffi,\nVotre devis est prêt : https://ksp.bj/mon-espace?a=1&b=<2>',
  },
  locale: 'fr',
};

interface Call {
  url: string;
  init: RequestInit;
}

function provider(
  reply: (call: Call) => Promise<Response> | Response,
  options: Partial<BrevoEmailOptions> = {},
) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    email: new BrevoEmailProvider({
      apiKey: API_KEY,
      senderAddress: 'notifications@ksp.bj',
      senderName: 'Groupe KSP',
      timeoutMs: 5000,
      fetch: fakeFetch,
      ...options,
    }),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('BrevoEmailProvider', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('envoie l’e-mail par l’API transactionnelle v3, clé dans l’en-tête api-key', async () => {
    const { calls, email } = provider(() =>
      json(201, { messageId: '<202610231200.123@smtp-relay.mailin.fr>' }),
    );

    await expect(email.send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: '<202610231200.123@smtp-relay.mailin.fr>',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({
      'api-key': API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      sender: { name: 'Groupe KSP', email: 'notifications@ksp.bj' },
      to: [{ email: ADDRESS }],
      subject: 'Votre devis de nettoyage',
      textContent: message.content!.text,
      tags: ['cleaning.quote_sent.customer'],
    });
    // Le HTML est échappé : une variable ne peut pas injecter de balise.
    expect(body.htmlContent).toContain('<p>Bonjour Koffi,</p>');
    expect(body.htmlContent).toContain('&lt;2&gt;');
    expect(body.htmlContent).not.toContain('<2>');
  });

  it.each([
    [400, 'invalid_parameter', 'recipient_invalid'],
    [401, 'unauthorized', 'provider_rejected'],
    [403, 'permission_denied', 'provider_rejected'],
    [400, 'missing_parameter', 'provider_rejected'],
    [402, 'not_enough_credits', 'provider_unavailable'],
    [429, 'too_many_requests', 'provider_unavailable'],
    [500, 'internal_error', 'provider_unavailable'],
    [503, 'unknown', 'provider_unavailable'],
  ])('HTTP %i, code Brevo %s → %s', async (status, code, reason) => {
    const { email } = provider(() => json(status, { code, message: `refus pour ${ADDRESS}` }));
    await expect(email.send(message)).resolves.toEqual({ accepted: false, reason });
  });

  it('délai dépassé ou erreur réseau → prestataire indisponible', async () => {
    const slow = provider(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(slow.email.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
    expect(logs.join('\n')).toContain('pas de réponse en 5000 ms');

    const down = provider(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.email.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
  });

  it('réponse acceptée sans identifiant de message → indisponible', async () => {
    const { email } = provider(() => json(201, {}));
    await expect(email.send(message)).resolves.toEqual({ accepted: false, reason: 'provider_unavailable' });
  });

  it('adresse absente ou mal formée : refus sans appel à Brevo', async () => {
    const { calls, email } = provider(() => json(201, { messageId: 'x' }));
    await expect(email.send({ ...message, email: null })).resolves.toEqual({
      accepted: false,
      reason: 'recipient_invalid',
    });
    await expect(email.send({ ...message, email: 'pas-une-adresse' })).resolves.toEqual({
      accepted: false,
      reason: 'recipient_invalid',
    });
    expect(calls).toHaveLength(0);
  });

  it('modèle sans texte (code de connexion) : jamais envoyé par e-mail', async () => {
    const { calls, email } = provider(() => json(201, { messageId: 'x' }));
    await expect(email.send({ ...message, content: null })).resolves.toEqual({
      accepted: false,
      reason: 'provider_rejected',
    });
    expect(calls).toHaveLength(0);
  });

  it('les journaux ne contiennent ni la clé, ni l’adresse, ni le texte du message', async () => {
    for (const reply of [
      () => json(401, { code: 'unauthorized', message: `Key not found ${API_KEY}` }),
      () => json(400, { code: 'invalid_parameter', message: `email is not valid: ${ADDRESS}` }),
      () => json(201, {}),
    ]) {
      await provider(reply).email.send(message);
    }
    const output = logs.join('\n');
    expect(output).toContain('HTTP 401');
    expect(output).toContain('unauthorized');
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(ADDRESS);
    expect(output).not.toContain('koffi');
    expect(output).not.toContain('Votre devis est prêt');
  });
});
