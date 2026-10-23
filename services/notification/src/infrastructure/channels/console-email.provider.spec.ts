import { type OutgoingMessage } from '../../application/send/notification.ports';
import { ConsoleEmailProvider } from './console-email.provider';

const message: OutgoingMessage = {
  notificationId: 'n-1',
  channel: 'email',
  templateCode: 'cleaning.mission_completed.customer',
  phoneE164: null,
  email: 'koffi.adjovi@example.com',
  variables: {},
  content: { subject: 'Prestation de nettoyage terminée', text: 'Bonjour Koffi,\nMerci.' },
  locale: 'fr',
};

describe('ConsoleEmailProvider (développement)', () => {
  it('écrit l’objet et le texte dans le terminal, avec l’adresse masquée', async () => {
    const lines: string[] = [];
    const provider = new ConsoleEmailProvider((text) => lines.push(text));
    await expect(provider.send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: 'console-email-n-1',
    });
    const output = lines.join('');
    expect(output).toContain('k***@example.com');
    expect(output).toContain('Objet : Prestation de nettoyage terminée');
    expect(output).toContain('Merci.');
    expect(output).not.toContain('koffi.adjovi@');
  });

  it('refuse un destinataire sans adresse', async () => {
    const provider = new ConsoleEmailProvider(() => undefined);
    await expect(provider.send({ ...message, email: null })).resolves.toEqual({
      accepted: false,
      reason: 'recipient_invalid',
    });
  });
});
