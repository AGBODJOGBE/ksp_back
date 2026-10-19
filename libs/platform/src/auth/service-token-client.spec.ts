import { ServiceTokenClient } from './service-token-client';

function client(responses: (() => Response | Promise<Response>)[], now = { value: 1_000_000 }) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('aucune réponse prévue');
    return next();
  }) as unknown as typeof fetch;
  const tokens = new ServiceTokenClient({
    tokenUrl: 'http://identity:3101/oauth/token',
    clientId: 'gateway',
    clientSecret: 'secret',
    fetchImpl,
    now: () => now.value,
  });
  return { tokens, calls, now };
}

const ok =
  (token: string, expiresIn = 300) =>
  () =>
    new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }), {
      status: 200,
    });

describe('ServiceTokenClient', () => {
  it('demande un jeton par le flux client credentials', async () => {
    const { tokens, calls } = client([ok('t-1')]);
    await expect(tokens.getToken('identity')).resolves.toBe('t-1');
    expect(calls[0].url).toBe('http://identity:3101/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'gateway',
      client_secret: 'secret',
      audience: 'identity',
    });
  });

  it('réutilise le jeton en cache, et le renouvelle une minute avant son expiration', async () => {
    const { tokens, calls, now } = client([ok('t-1'), ok('t-2')]);
    await tokens.getToken('identity');
    now.value += 200_000;
    await expect(tokens.getToken('identity')).resolves.toBe('t-1');
    now.value += 50_000;
    await expect(tokens.getToken('identity')).resolves.toBe('t-2');
    expect(calls).toHaveLength(2);
  });

  it('garde un jeton par service appelé', async () => {
    const { tokens, calls } = client([ok('pour-identity'), ok('pour-notification')]);
    await expect(tokens.getToken('identity')).resolves.toBe('pour-identity');
    await expect(tokens.getToken('notification')).resolves.toBe('pour-notification');
    expect(calls).toHaveLength(2);
  });

  it('partage une seule requête entre deux demandes simultanées', async () => {
    const { tokens, calls } = client([ok('t-1')]);
    const [a, b] = await Promise.all([tokens.getToken('identity'), tokens.getToken('identity')]);
    expect([a, b]).toEqual(['t-1', 't-1']);
    expect(calls).toHaveLength(1);
  });

  it('signale un refus d’identity comme une erreur de configuration', async () => {
    const { tokens } = client([
      () => new Response(JSON.stringify({ error: 'invalid_target' }), { status: 400 }),
    ]);
    await expect(tokens.getToken('payment')).rejects.toMatchObject({
      code: 'SERVICE_TOKEN_REFUSED',
      message: expect.stringContaining('invalid_target'),
    });
  });

  it('signale identity injoignable comme une indisponibilité, et réessaie à la demande suivante', async () => {
    const { tokens } = client([
      () => {
        throw new TypeError('fetch failed');
      },
      ok('t-1'),
    ]);
    await expect(tokens.getToken('identity')).rejects.toMatchObject({
      code: 'SERVICE_TOKEN_UNAVAILABLE',
      kind: 'UNAVAILABLE',
    });
    await expect(tokens.getToken('identity')).resolves.toBe('t-1');
  });
});
