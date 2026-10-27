import { Logger } from '@nestjs/common';
import { type OutgoingMessage } from '../../application/send/notification.ports';
import { MetaWhatsAppProvider, type MetaWhatsAppOptions } from './meta-whatsapp.provider';

const TOKEN = 'EAAG-secret-token';

const message: OutgoingMessage = {
  notificationId: 'n-1',
  channel: 'whatsapp',
  templateCode: 'identity.otp',
  phoneE164: '+2290197000045',
  email: null,
  content: null,
  variables: { code: '482913', expires_in_minutes: '5' },
  locale: 'fr',
};

interface Call {
  url: string;
  init: RequestInit;
}

function provider(
  reply: (call: Call) => Promise<Response> | Response,
  options: Partial<MetaWhatsAppOptions> = {},
) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    whatsapp: new MetaWhatsAppProvider({
      accessToken: TOKEN,
      phoneNumberId: '106540352242922',
      apiVersion: 'v23.0',
      otpTemplate: 'ksp_otp',
      language: 'fr',
      timeoutMs: 2000,
      fetch: fakeFetch,
      ...options,
    }),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const graphError = (status: number, code: number) =>
  json(status, { error: { message: 'erreur', type: 'OAuthException', code, fbtrace_id: 'AbCdEf' } });

describe('MetaWhatsAppProvider', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((text: unknown) => void logs.push(String(text)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation((text: unknown) => void logs.push(String(text)));
  });

  afterEach(() => jest.restoreAllMocks());

  it('envoie le modèle d’authentification « Copier le code », le code dans le corps et dans le bouton', async () => {
    const { calls, whatsapp } = provider(() =>
      json(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: '+2290197000045', wa_id: '2290197000045' }],
        messages: [{ id: 'wamid.HBgLMjI5MDE5NzAwMDA0NRUCABEYEjA', message_status: 'accepted' }],
      }),
    );

    await expect(whatsapp.send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: 'wamid.HBgLMjI5MDE5NzAwMDA0NRUCABEYEjA',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/106540352242922/messages');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+2290197000045',
      type: 'template',
      template: {
        name: 'ksp_otp',
        language: { code: 'fr' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
        ],
      },
    });
  });

  it.each([
    [400, 131026, 'recipient_invalid'],
    [400, 131021, 'recipient_invalid'],
    [500, 1, 'provider_unavailable'],
    [503, 133004, 'provider_unavailable'],
    [400, 130429, 'provider_unavailable'],
    [400, 131056, 'provider_unavailable'],
    [401, 190, 'provider_rejected'],
    [400, 132001, 'provider_rejected'],
    [400, 100, 'provider_rejected'],
  ])('HTTP %i, erreur Graph %i → %s', async (status, code, reason) => {
    const { whatsapp } = provider(() => graphError(status, code));
    await expect(whatsapp.send(message)).resolves.toEqual({ accepted: false, reason });
  });

  it('HTTP 429 ou 5xx sans corps lisible → prestataire indisponible', async () => {
    const tooMany = provider(() => new Response('trop de requêtes', { status: 429 }));
    await expect(tooMany.whatsapp.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
    const down = provider(() => new Response('<html>502</html>', { status: 502 }));
    await expect(down.whatsapp.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
  });

  it('erreur réseau → prestataire indisponible', async () => {
    const { whatsapp } = provider(() => {
      throw new TypeError('fetch failed');
    });
    await expect(whatsapp.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
    expect(logs).toEqual(['WhatsApp injoignable (erreur réseau).']);
  });

  it('pas de réponse dans le délai → l’appel est interrompu, prestataire indisponible', async () => {
    const { whatsapp } = provider(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      { timeoutMs: 20 },
    );
    await expect(whatsapp.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
    expect(logs).toEqual(['WhatsApp injoignable (pas de réponse en 20 ms).']);
  });

  it('réponse acceptée sans identifiant de message → prestataire indisponible (pas d’accusé)', async () => {
    const { whatsapp } = provider(() => json(200, { messages: [] }));
    await expect(whatsapp.send(message)).resolves.toEqual({
      accepted: false,
      reason: 'provider_unavailable',
    });
  });

  it('modèle sans équivalent WhatsApp → refus, sans appel à Meta', async () => {
    const { calls, whatsapp } = provider(() => json(200, {}));
    await expect(whatsapp.send({ ...message, templateCode: 'document.signature' })).resolves.toEqual({
      accepted: false,
      reason: 'provider_rejected',
    });
    expect(calls).toHaveLength(0);
  });

  it('ne journalise ni le jeton, ni le numéro, ni le code', async () => {
    const { whatsapp } = provider(() => graphError(400, 131026));
    await whatsapp.send(message);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('131026');
    expect(logs[0]).toContain('AbCdEf');
    for (const secret of [TOKEN, '0197000045', '482913']) expect(logs.join('\n')).not.toContain(secret);
  });

  it('message d’un événement : modèle « utility » approuvé, paramètres dans l’ordre du texte', async () => {
    const { calls, whatsapp } = provider(() => json(200, { messages: [{ id: 'wamid.event' }] }));
    const event: OutgoingMessage = {
      ...message,
      templateCode: 'cleaning.quote_sent.customer',
      variables: {
        first_name: '',
        total: '150\u00a0000\u00a0FCFA',
        valid_until: '15 novembre 2026',
        link: 'https://ksp.bj/mon-espace/nettoyage/demandes/r-1',
      },
      content: { subject: 'Votre devis de nettoyage', text: 'Bonjour,' },
    };
    await expect(whatsapp.send(event)).resolves.toEqual({ accepted: true, providerMessageId: 'wamid.event' });
    expect(JSON.parse(calls[0]!.init.body as string).template).toEqual({
      name: 'ksp_cleaning_quote_sent',
      language: { code: 'fr' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Madame, Monsieur' },
            { type: 'text', text: '150\u00a0000\u00a0FCFA' },
            { type: 'text', text: '15 novembre 2026' },
            { type: 'text', text: 'https://ksp.bj/mon-espace/nettoyage/demandes/r-1' },
          ],
        },
      ],
    });
  });

  it('modèle d’annulation choisi selon le motif', async () => {
    const { calls, whatsapp } = provider(() => json(200, { messages: [{ id: 'wamid.c' }] }));
    await whatsapp.send({
      ...message,
      templateCode: 'cleaning.request_cancelled.customer',
      variables: { first_name: 'Awa', case: 'rejected', scope: 'request', link: 'https://ksp.bj/x' },
    });
    const template = JSON.parse(calls[0]!.init.body as string).template;
    expect(template.name).toBe('ksp_cleaning_rejected');
    expect(template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
      'Awa',
      'votre demande',
      'https://ksp.bj/x',
    ]);
  });

  it.each([
    [
      '0',
      'ksp_billing_invoice_paid',
      ['Awa', 'FAC-2026-000042', 'montant', '16 décembre 2026', 'https://ksp.bj/f'],
    ],
    [
      '2',
      'ksp_billing_invoice_paid_unpaid_left',
      ['Awa', 'FAC-2026-000042', 'montant', '16 décembre 2026', '2', 'https://ksp.bj/f'],
    ],
  ])('facture réglée, %s impayée(s) restante(s) : modèle %s', async (unpaidLeft, name, parameters) => {
    const { calls, whatsapp } = provider(() => json(200, { messages: [{ id: 'wamid.p' }] }));
    await whatsapp.send({
      ...message,
      templateCode: 'billing.invoice_paid.customer',
      variables: {
        first_name: 'Awa',
        invoice_number: 'FAC-2026-000042',
        total: 'montant',
        paid_on: '16 décembre 2026',
        unpaid_left: unpaidLeft,
        link: 'https://ksp.bj/f',
      },
    });
    const template = JSON.parse(calls[0]!.init.body as string).template;
    expect(template.name).toBe(name);
    expect(template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(parameters);
  });

  it('destinataire sans numéro : refus sans appel à Meta', async () => {
    const { calls, whatsapp } = provider(() => json(200, { messages: [{ id: 'x' }] }));
    await expect(whatsapp.send({ ...message, phoneE164: null })).resolves.toEqual({
      accepted: false,
      reason: 'recipient_invalid',
    });
    expect(calls).toHaveLength(0);
  });
});
