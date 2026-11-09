import { type DocumentContent } from './content';
import { formatDateTime } from './format';
import { type CodeChannel } from './signature';

/** Version de la page de certificat, conservée dans la preuve. */
export const CERTIFICATE_VERSION = 1;

export interface CertificateInput {
  documentTitle: string;
  documentNumber: string;
  /** Pages du document signé (avant la page de certificat). */
  pageCount: number;
  documentSha256: string;
  signerName: string;
  signerHasAccount: boolean;
  signerPhoneMasked: string;
  channel: CodeChannel;
  signedAt: Date;
  ip: string | null;
  userAgent: string | null;
  signatureRequestId: string;
  issuerName: string;
  timeZone: string;
}

const CHANNELS: Record<CodeChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'e-mail',
  sms: 'SMS',
};

/**
 * Page de certificat ajoutée aux pages d'origine, inchangées (ADR-044) : qui a signé, quand, par
 * quel moyen, et l'empreinte qui permet de vérifier que les pages signées n'ont pas été modifiées.
 */
export function certificateContent(input: CertificateInput): DocumentContent {
  const pages = input.pageCount === 1 ? 'la page 1' : `les pages 1 à ${input.pageCount}`;
  return {
    title: 'Certificat de signature électronique',
    number: input.documentNumber,
    dateLine: `Établi le ${formatDateTime(input.signedAt, input.timeZone)} (heure du Bénin)`,
    blocks: [
      {
        kind: 'paragraph',
        text:
          `Ce certificat atteste la signature électronique du document « ${input.documentTitle} » ` +
          `(${input.documentNumber}), dont il constitue la dernière page. La signature porte sur ` +
          `${pages}, présentées au signataire et restées inchangées.`,
      },
      { kind: 'heading', text: 'Document signé' },
      {
        kind: 'fields',
        rows: [
          ['Document', `${input.documentTitle} (${input.documentNumber})`],
          ['Pages signées', String(input.pageCount)],
          ['Empreinte SHA-256', input.documentSha256],
        ],
      },
      { kind: 'heading', text: 'Signataire' },
      {
        kind: 'fields',
        rows: [
          ['Nom', input.signerName],
          [
            'Identification',
            input.signerHasAccount
              ? 'Compte KSP du signataire, connecté'
              : 'Sans compte KSP : lien de signature personnel',
          ],
          ['Téléphone', input.signerPhoneMasked || 'non communiqué'],
        ],
      },
      { kind: 'heading', text: 'Signature' },
      {
        kind: 'fields',
        rows: [
          ['Moyen', `Code à usage unique de 6 chiffres reçu par ${CHANNELS[input.channel]}`],
          ['Date et heure', `${formatDateTime(input.signedAt, input.timeZone)} (heure du Bénin)`],
          ['Date et heure UTC', input.signedAt.toISOString()],
          ['Adresse IP', input.ip ?? 'non transmise'],
          ['Navigateur', input.userAgent ?? 'non transmis'],
          ['Demande de signature', input.signatureRequestId],
        ],
      },
      {
        kind: 'paragraph',
        strong: true,
        text: 'Le signataire a déclaré avoir lu le document et en accepter le contenu.',
      },
      {
        kind: 'paragraph',
        text:
          `La preuve de cette signature est conservée par ${input.issuerName}. L’empreinte SHA-256 ` +
          'ci-dessus est celle du fichier PDF présenté au signataire : toute modification de ce ' +
          'fichier, même d’un seul caractère, donnerait une empreinte différente.',
      },
    ],
  };
}
