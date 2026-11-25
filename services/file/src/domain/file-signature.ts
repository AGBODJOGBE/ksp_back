import { type ContentType } from './purposes';

/**
 * Nombre d'octets lus en tête du contenu pour le reconnaître : la signature des types binaires
 * tient dans les premiers octets ; un CSV, sans signature, est jugé sur cet en-tête.
 */
export const SIGNATURE_BYTES = 512;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** En-tête local d'une archive ZIP (`PK\x03\x04`), aussi celui d'un classeur XLSX. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;

/**
 * Texte : ni octet nul ni caractère de contrôle, hors tabulation et fins de ligne (CR, LF). Les
 * octets au-delà de 0x7f (UTF-8, dont la marque d'ordre EF BB BF, ou Windows-1252) sont admis.
 */
function isText(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  return head.every((byte) => (byte >= 0x20 && byte !== DEL) || byte === TAB || byte === LF || byte === CR);
}

/** Reconnaissance de chaque type accepté, sur les premiers octets de son contenu. */
const SIGNATURES: Record<ContentType, (head: Uint8Array) => boolean> = {
  'application/pdf': (head) => startsWith(head, ascii('%PDF-')),
  'image/jpeg': (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  'image/png': (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8),
  // Un classeur Office Open XML est une archive ZIP : même signature, contenu lu par le service.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (head) => startsWith(head, ZIP),
  'application/zip': (head) => startsWith(head, ZIP),
  // Pas de signature : un CSV est accepté si son en-tête est du texte.
  'text/csv': isText,
};

/**
 * Le contenu porte-t-il la signature binaire (« nombre magique ») du type déclaré ? Contrôle
 * indépendant du nom du fichier : un HTML déguisé en image, un exécutable déguisé en PDF ou en
 * tableur sont refusés.
 */
export function matchesSignature(contentType: ContentType, head: Uint8Array): boolean {
  return SIGNATURES[contentType](head);
}
