import { type ContentType } from './purposes';

/** Nombre d'octets lus en tête du contenu pour reconnaître son type. */
export const SIGNATURE_BYTES = 16;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * Type réel d'un contenu, reconnu à sa signature binaire (« nombre magique »), indépendamment du
 * type déclaré par le client et du nom du fichier. null : aucun type accepté ne correspond.
 */
export function detectContentType(head: Uint8Array): ContentType | null {
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}
