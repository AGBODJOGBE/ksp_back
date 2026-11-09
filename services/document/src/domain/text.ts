/** Le texte contient-il un caractère de contrôle (hors saut de ligne si `allowNewline`) ? */
export function hasControlCharacter(value: string, allowNewline = false): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (allowNewline && char === '\n') continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Remplace les caractères de contrôle par des espaces. */
export function stripControlCharacters(value: string): string {
  return [...value].map((char) => (hasControlCharacter(char) ? ' ' : char)).join('');
}
