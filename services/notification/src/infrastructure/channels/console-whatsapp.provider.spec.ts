import { ConsoleWhatsAppProvider } from './console-whatsapp.provider';

describe('ConsoleWhatsAppProvider (développement)', () => {
  it('écrit le code dans le terminal et rend un accusé de prise en charge', async () => {
    const lines: string[] = [];
    const provider = new ConsoleWhatsAppProvider((text) => lines.push(text));

    await expect(
      provider.send({
        notificationId: 'n-1',
        channel: 'whatsapp',
        templateCode: 'identity.otp',
        phoneE164: '+2290197000045',
        variables: { code: '482913', expires_in_minutes: '5' },
        locale: 'fr',
      }),
    ).resolves.toEqual({ accepted: true, providerMessageId: 'console-n-1' });

    const output = lines.join('');
    expect(output).toContain('identity.otp');
    expect(output).toContain('code=482913');
    expect(output).toContain('expires_in_minutes=5');
    // Le numéro reste masqué, même en développement.
    expect(output).toContain('+229********45');
    expect(output).not.toContain('0197000045');
  });
});
